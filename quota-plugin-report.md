# Report: OpenCode plugin for the platform quotas

Deliverables in this repository:

- the `opencode-llm-quota` plugin (`src/`), its unit tests (`test/`), its end-to-end tests against
  real OpenCode releases (`test/e2e/`), and its README;
- the change proposed for `opencode-keycloak-auth`, as a separate diff:
  `patches/opencode-keycloak-auth-token-source.diff` (5 files, 160 added lines, nothing removed). The
  end-to-end tests apply it to `opencode-keycloak-auth` v1.0.0 and use the result. It is not pushed.

Same tooling and conventions as `opencode-keycloak-auth`: strict TypeScript, tsup (ESM, no runtime
dependency), vitest, eslint, prettier, GitHub CI on Node 20 and 22, release on tag (single file, tarball,
npm), a plain `{ id, setup, server }` export for v1 and v2, `server.js` and `tui.js` at the root.

## Results on real OpenCode

`npm run test:e2e` runs the packed plugin in the real OpenCode binaries, each in its own HOME, with
opencode-keycloak-auth v1.0.0 plus the patch, a fake gateway serving the quota route report's responses,
and a fake model. TUI checks run the real TUI in a pseudo-terminal and read the rendered screen. Last run:
22 of 22 passed in 378 s.

| Check                                                                | 1.17.11 | 1.19.6 | 2.0.25 | 2.3.2 |
| -------------------------------------------------------------------- | ------- | ------ | ------ | ----- |
| Nothing sent before opencode-keycloak-auth has a token               | pass    | pass   |        |       |
| Read after a response, with the keycloak token, plus a toast         | pass    | pass   |        |       |
| Other models read soon after the token appears                       | pass    | pass   |        |       |
| `quota` tool lists every model                                       | pass    | pass   | pass   | pass  |
| Toast in the v1 TUI                                                  | pass    | pass   |        |       |
| Server and TUI parts loaded                                          |         |        | pass   | pass  |
| One read per model with the host's token, two locations open         |         |        | pass   | pass  |
| Read again after a response, not before a minute after the last read |         |        | pass   | pass  |
| `/quota` dialog                                                      |         |        | pass   | pass  |
| Status line of the selected model, and a toast on a change           |         |        | pass   | pass  |

Empty cells are checks that do not apply to that major version.

## 1. Token and gateway URL

### Gateway URL and models

No URL is hard-coded. On each cycle the plugin reads the platform provider from the running OpenCode:

| Host | Source                                                 | Fields                                                                      |
| ---- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| v2   | `ctx.provider.get({ providerID })`, `ctx.model.list()` | `settings.baseURL`, `integrationID`; the provider's models, `modelID`       |
| v1   | `client.config.get()`                                  | `provider.<id>.options.baseURL`; `provider.<id>.models`: `id`, else the key |

- The provider is opencode-keycloak-auth's, with no cross-configuration: `providerId` defaults to
  `OPENCODE_KC_PROVIDER_ID`, else `keycloak`.
- Route: `GET <baseURL origin>/v1/quota?model=<name>`. `quotaPath` matches the chart value
  `rateLimiting.quotaLookup.path`.
- Workspace switch: when the `baseURL` origin changes, the state resets and reads go to the new gateway,
  without a reinstall. The plugin reads the config of the running OpenCode instance, the same one the
  LLM requests use (open question 3).
- Each model is queried under the name sent to the gateway, aliases included. A 404 parks the model: it
  shows nothing and is checked again after an hour.

### Token on OpenCode v2: the host API, no change to opencode-keycloak-auth

`ctx.integration.connection.active(integrationID)` returns the connection, then `.resolve(connection)`
returns the credential. Both are in the official types (`@opencode/plugin` 2.0.25 and 2.3.2).
`integrationID` is `provider.integrationID ?? providerId`, the rule the host applies to LLM requests.

- The host refreshes an expiring credential through opencode-keycloak-auth's `refresh`. The quota plugin
  has no OIDC logic and reads no secret.
- Only an `oauth` credential is used. An API key is never sent; the route would refuse it anyway (401).

### Token on OpenCode v1: no existing interface, hence the diff

- The v1 API has no way to read another provider's credential: `client.auth` only has `set`.
- `auth()`, handed to the `loader`, belongs to the provider's `auth` hook, so to opencode-keycloak-auth.
- opencode-keycloak-auth exports nothing another plugin can use, and the two ship as separate bundles.
- Ruled out as undocumented internals: reading `auth.json`, or taking `apiKey`/`fetch` from
  `ProviderContext.options` in the `chat.headers` hook.

The proposed change adds `src/token-source.ts` (65 lines) and 5 lines to `src/loader.ts`. When its loader
runs, opencode-keycloak-auth publishes:

```ts
globalThis[Symbol.for("opencode-keycloak-auth/token-source@1")] = {
  version: 1,
  token(providerId: string): Promise<string | undefined>,
};
```

`token()` calls the same `resolveAccessToken(auth)` as the provider's requests (live credentials,
single-flight refresh near expiry) and returns `undefined` when there is no login, no OAuth credential or
a failed refresh. It never throws, never starts a login and never exposes the refresh token. The key is
versioned. The diff also adds 4 tests, a README section and a CHANGELOG entry.

The token exists once OpenCode has called the loader, at the first request to the provider. Until then
the plugin sends nothing and checks again every 10 seconds, locally.

### Guarantees

- The token goes only to the origin of the provider's `baseURL`, where LLM requests already send it. Non
  http(s) URLs and redirects are refused.
- Neither the token nor a response body is logged. Error bodies are not even read.
- No token: nothing is sent, the line reads "quota unavailable", no toast, no login.
- No LLM request is blocked, delayed or changed. On v1 the plugin registers `event`, `tool` and `dispose`
  only; on v2 no session or model hook. A test checks both.

## 2. OpenCode APIs and versions

**OpenCode v2**, `@opencode/plugin` 2.0.25; the files used are identical in 2.3.2 except `event.subscribe`,
whose `subscribe({ signal })` call works on both.

| Need              | API                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| Gateway, models   | `ctx.provider.get`, `ctx.model.list`                                                  |
| Token             | `ctx.integration.connection.active`, `.resolve`                                       |
| End of a response | `ctx.event.subscribe`: `session.step.started`, then `session.step.ended` or `.failed` |
| Server to TUI     | `ctx.rpc.register` (JSON Schema definition), `ctx.client.rpc(definition)` in the TUI  |
| `quota` tool      | `ctx.tool.transform(editor => editor.add(…))`                                         |
| Status bar        | TUI `ui.slot({ after: "prompt.footer.status" })`, `ui.model.current()`                |
| Toasts            | TUI `ui.toast.show`, on the RPC `toast` event                                         |
| `/quota`          | TUI `keymap.layer` (`mode: "global"`, `slash`, `palette`), `ui.dialog.alert`          |
| TUI state         | TUI `storage.memory`                                                                  |

The TUI part renders with `createElement`, `insert` and `setProp` from `@opentui/solid`, which the host
provides; the end-to-end tests confirm it resolves on 2.0.25 and 2.3.2.

**OpenCode v1**, `@opencode-ai/plugin` 1.17.11; the parts used are identical in 1.19.6.

| Need              | API                                                                           |
| ----------------- | ----------------------------------------------------------------------------- |
| Gateway, models   | `client.config.get()`                                                         |
| Token             | opencode-keycloak-auth's token source (the diff)                              |
| End of a response | `event` hook, `message.updated` of an assistant message with `time.completed` |
| Toasts            | `client.tui.showToast`                                                        |
| `quota` tool      | `tool` hook (`args: {}`, no runtime zod)                                      |

Minimum versions: OpenCode 1.17 (v1) and 2.0.25 (v2), the same floors as opencode-keycloak-auth.

| Host                                                  | Status bar                | Toasts | `/quota` | `quota` tool |
| ----------------------------------------------------- | ------------------------- | ------ | -------- | ------------ |
| v2 2.0.25 and later, installed as a folder or package | yes                       | yes    | yes      | yes          |
| v2, single file in `plugins/` (no TUI part)           | no                        | no     | no       | yes          |
| v2 with a failed RPC registration                     | no                        | no     | no       | yes          |
| v1 1.17 to 1.19                                       | no                        | yes    | no       | yes          |
| v1 before 1.17, v2 before 2.0.25                      | not supported, not tested |        |          |              |

v1 has no status bar: its TUI plugins run apart from the server, a server plugin can send them nothing
but `prompt.append`, `command.execute` and `toast.show`, and the TUI part would have no token.

## 3. What the real OpenCode runs changed

The first runs against real binaries found problems that the unit tests and the types could not show.
Each one is fixed and covered by a test.

1. **OpenCode v1 also calls `setup()`.** 1.17 calls both `server()` and the v2 `setup()`, with a context
   that lacks the v2 domains. The v2 code now returns quietly when `provider.get`, `model.list`,
   `integration.connection` or `event.subscribe` is missing. opencode-keycloak-auth has the same double
   call (it logs "configured (v2)" under v1); harmless there, noted for its maintainers.
2. **One plugin instance per location on v2.** The v2 service creates an instance per open project
   directory, so each one polled on its own: two reads per model per minute with two projects open. A
   process-wide ledger (`src/shared-reads.ts`, keyed by URL and a token fingerprint) now lets instances
   share one read per minute.
3. **The token arrives late on v1.** It exists only after the first LLM request, so the first reads found
   none and the other models waited a full minute. With no token or no provider, nothing reaches the
   gateway, so the plugin now checks again after 10 seconds.
4. **The provider arrives late on v2.** At `setup()` the config overlay is not loaded yet ("Provider not
   found"). Same 10-second retry.
5. **The TUI can start before the server part of its location.** `snapshot()` then fails with
   `rpc.unavailable`, and the status bar stayed empty. The TUI retries, and the server sends the snapshot
   after every cycle, changed or not.
6. **`/quota` was missing from the slash list.** Typing `/` switches the keymap to its autocomplete mode;
   the layer is now `mode: "global"`, created inside an `app` slot render like the built-in plugins.
7. **The status line wrapped on the home screen**, whose footer is narrow. It is now cut, not wrapped.
8. **OpenCode 2.3 reaches plugin tools through Code Mode.** The model sees an `execute` tool and a
   catalog entry `tools.quota()`. Nothing to change in the plugin; the fake model in the tests calls it
   that way.
9. **Plugin console output is invisible on v2**, even with `--print-logs`. `OPENCODE_QUOTA_LOG_FILE`
   writes the log lines to a file.
10. **The `quota` tool answered before the first read.** A v2 location created for a `run` has no state
    yet, so the tool replied "Quota unavailable". The tool now waits for one read cycle (at most 12
    seconds) when nothing is known; models already read keep their one-minute floor.

## 4. Sample output

From the code (`compactLine`, `transitions`, `renderDetail`) on the sample responses of
`test/fixtures.ts`, in the rate-limit service's `POST /quota` format; two of them are the real responses of the quota route
report, verbatim. Time zone `Europe/Paris`. `test/display-table.test.ts` checks the same cases in UTC.

### Status line

Model A has a soft budget, Model B has hard limits; the labels come from the `labels` option.

| Case                        | Response                                       | Line                                                                        |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| Soft budget, some left      | `over: false`, `level` 372 of 600              | `Model A · normal priority · budget 62% left`                               |
| Soft budget used up         | `over: true`, `level` −45, `resets_in_s` 30100 | `Model A · low priority · normal in ~35 min`                                |
| Real response of the report | `level` −45, `resets_in_s` 2320, 107.5% used   | `Model A · low priority · normal in ~3 min`                                 |
| Soft budget, `level` 0      | `over: true`, `level` 0                        | `Model A · low priority · normal soon`                                      |
| Daily cap                   | daily 41%, `resets_in_s` 21600                 | `Model B · today 41% · resets in 6h`                                        |
| Real response of the report | daily 68%, `resets_in_s` 37567                 | `Model B · today 68% · resets in 10h`                                       |
| Per minute at 80% or less   | 48 of 60                                       | `Model B · today 41% · resets in 6h`                                        |
| Per minute above 80%        | 52 of 60                                       | `Model B · today 41% · resets in 6h · 52/60 req/min`                        |
| Weekly cap under 50%        | 49.9%                                          | `Model A · normal priority · budget 62% left`                               |
| Weekly cap from 50%         | 78%, `resets_at` 2026-11-23T09:00Z             | `Model A · normal priority · budget 62% left · week 78% · resets Mon 10:00` |
| In flight under 12 of 16    | 11                                             | `Model A · normal priority · budget 62% left`                               |
| In flight from 12 of 16     | 14                                             | `Model A · normal priority · budget 62% left · in flight 14/16`             |
| Read failed                 | no token, 401, 5xx                             | `Model A · quota unavailable`                                               |

A budget in debt always reads "low priority", never a percentage. A hard cap above 100% shows 100%.

### Toasts, on state changes only

| Change                  | Variant | Message                                      |
| ----------------------- | ------- | -------------------------------------------- |
| Drops to low priority   | warning | `Model A · low priority · normal in ~35 min` |
| Back to normal priority | success | `Model A · back to normal priority`          |
| Daily cap crosses 80%   | warning | `Model B · today 85% · resets in 6h`         |
| Daily cap crosses 100%  | error   | `Model B · daily cap reached · resets in 6h` |
| Weekly cap crosses 80%  | warning | `Model A · week 81% · resets Mon 10:00`      |

Going down (a reset, a refill) is silent, except the return to normal priority. Per-minute caps and
requests in flight never toast. The first read is compared with "normal, 0%".

### Detail (`/quota` on v2, `quota` tool on v1 and v2)

Captured from the OpenCode 2.3.2 TUI, `/quota`:

```
Quotas · http://127.0.0.1:49598
Model A (model-a)
  low priority · normal in ~3 min
  week 34% · resets Sat 19:00
  in flight 0/16
  read 20s ago
Model B (model-b)
  per minute: 1/60 req/min
  today 68% · resets in 10h
  read 20s ago
Jina (jina-embeddings-v5): no quota on this model
```

### Time back to normal priority

Rate = (`limit` − `level`) / `resets_in_s`, only when `resets_in_s` > 0; time = −`level` / rate, rounded up
to the minute, at least 1 minute. The code computes −`level` × `resets_in_s` / (`limit` − `level`), the same
formula with one division, so an exact 2100 s stays 35 minutes. `level` 0, or above 0 with `over: true`:
"normal soon". No usable `resets_in_s`: "low priority" without a time. Tested in `test/format.test.ts`.

Limits are recognised by type and fields (`src/quota/classify.ts`): a soft budget is `soft: true` on a
`token_bucket`; requests in flight are a `concurrency` window with `in_flight`; a hard cap is a `fixed` or
`anchored` window of 60, 3600, 86400 or 604800 s, or a `unit` window. The documented order is kept and the
first of a kind wins. A name is used only for the `requests` prefix of the `<counted>_<window>` naming,
which changes the unit label. Anything else (`unlimited`, a hard bucket, an unknown window, a zero limit)
is ignored without error.

## 5. Call pace and errors

- Each model is read once at start, then every `intervalSeconds` (60 by default; lower values become 60).
- After a response of a model ends, its next read moves to 2 seconds later, never sooner than 60 seconds
  after the previous read of that model, even with a longer interval. Several responses close together
  give one read.
- One read per model per minute for the whole process, whatever the number of plugin instances.
- Nothing reads on a keystroke: only the timer and the end of responses trigger a read.
- The last state stays shown when the gateway fails; after 5 minutes without a read, its age is appended.
- Network error, 10-second timeout, 5xx, 429, invalid JSON, 401, 403: backoff 60 s, 120 s, 240 s… up to
  15 minutes. The end of a response does not shorten the backoff.
- 404: the model is parked for an hour, shown as "no quota", not counted as an error.
- No token or no provider yet: nothing is sent, checked again after 10 seconds.
- Logs: one `warn` when a model starts failing, one `info` when it recovers, the rest at `debug`. No error
  toast.
- Cost: with n models, at most n reads per minute and per workstation, plus at most one per model and per
  minute after responses, under the same floor.

Covered by `test/service.test.ts` with a fake clock, and measured on real OpenCode by the end-to-end tests.

## 6. Open questions

1. **Versions on the workstations.** Supported from 1.17 and 2.0.25, tested on 1.17.11, 1.19.6, 2.0.25 and
   2.3.2. Older versions on some workstations would need to be known.
2. **The opencode-keycloak-auth diff needs review, merge and release.** Without it, v1 shows "quota
   unavailable". v2 does not need it.
3. **Workspace switch while OpenCode runs.** The plugin follows the config of the running instance. If the
   internal CLI rewrites `opencode.json` without the instance reloading it, the plugin stays on the old
   gateway until a restart, like the LLM requests. Does the CLI trigger a reload?
4. **"budget 62% left"** reads `level / limit`, from the "fields" column of the display table. If the used
   share was meant, `budgetSegments` is the only function to change.
5. **Display names.** The `/v1/quota` response does not carry the model's name. The plugin shows the
   `labels` option, else the model's `name` in the config, else its id. Should the internal CLI write these
   names?
6. **Conditional windows (6:00 to 16:00 UTC, question 1 of the quota route report)** show at any
   hour, since the response does not say whether they apply. A header such as
   `x-quota-windows-active: false` would let the plugin hide them.
7. **401 as `text/plain` (question 2 of the quota route report):** the plugin reads the status only, so
   nothing to change on the gateway.
8. **Models read:** every model of the provider, every minute, used or not. Reads of models unused for 15
   minutes could be spaced out; not done, to stay with the requested pace.
9. **Toast at start:** a user who starts at low priority, or above 80% of a cap, gets one toast at the first
   read. Deliberate, easy to drop.
10. **Publication:** the npm name, the GitHub repository and the `NPM_TOKEN` secret are not created. Nothing
    is pushed.
11. **Your global OpenCode install does not start:** its binary has an invalid signature, so macOS kills it
    on launch (exit 137). A reinstall, or `codesign --force --sign -` on the binary, fixes it. The tests use
    their own copies in `.e2e/`.
