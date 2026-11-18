# Contributing

Thanks for helping with opencode-llm-quota. Bug reports, docs fixes, tests and features are all
welcome.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- No runtime dependency: Node built-ins and the global `fetch` only, so the plugin builds and runs on
  air-gapped hosts. OpenCode packages (`@opencode-ai/plugin`, `@opencode/plugin`) are imported with
  `import type` only; the TUI part may import `@opentui/solid`, which the host provides. Both rules are
  checked by `test/export.test.ts` and `scripts/check-bundle.mjs`.
- Never log, persist or send the token anywhere but the provider's gateway. Never log a `/v1/quota`
  body: model name, HTTP status and next attempt only.
- Respect the read pace: at most one gateway read per model and per minute for the whole process. A
  change that could read more often needs a test proving it does not.
- Never block, delay or change a request to a model.

## Development setup

Requires Node.js 20 or later and npm.

```bash
git clone <repository-url> opencode-llm-quota
cd opencode-llm-quota
npm ci
```

### Everyday commands

| Command                | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `npm run build`        | Bundle `dist/index.js` and `dist/tui.js` with tsup     |
| `npm test`             | Unit tests (Vitest), once                              |
| `npm run test:watch`   | Unit tests in watch mode                               |
| `npm run test:e2e`     | Real OpenCode releases against a fake gateway (~6 min) |
| `npm run typecheck`    | `tsc --noEmit`                                         |
| `npm run lint`         | ESLint                                                 |
| `npm run format`       | Prettier (write)                                       |
| `npm run format:check` | Prettier (check only)                                  |

Before opening a PR, run the check CI runs:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Run `npm run test:e2e` too when a change touches an entry point (`src/index.ts`, `src/v1`, `src/v2`,
`src/tui.ts`) or the RPC contract. It needs network access the first time and Python 3 for the TUI
checks, keeps the machine awake for the run, and needs port 127.0.0.1:49374 free (the OpenCode v2
service). Pick versions with `E2E_VERSIONS=1.19.6,2.3.2`.

## Project layout

```
src/
  index.ts          server part: { id, setup (v2, lazy), server (v1) }
  tui.ts            v2 TUI part: status line, toasts, /quota
  rpc.ts            RPC contract between the two parts
  service.ts        read scheduling, last state, snapshot
  shared-reads.ts   one read per URL and token per minute for the process
  gateway.ts        one GET /v1/quota
  config.ts, log.ts, models.ts, view.ts, id.ts, token-source.ts
  quota/            response parsing, limit classification, display, toast transitions
  v1/, v2/          host entry points
scripts/            check-bundle.mjs (run by `npm run build`)
patches/            proposed change to opencode-keycloak-auth (v1 token source)
test/               unit tests, one file per area; fixtures.ts holds /v1/quota bodies
test/e2e/           end-to-end suite and its harness
```

## Testing

- New behavior needs unit tests. They are hermetic: no network, no real timers. Inject `fetchImpl`,
  `now`, `setTimer` and `clearTimer` (see `test/helpers.ts`).
- Build quota bodies from `test/fixtures.ts`, in the rate-limit service's `POST /quota` format.
- The logger is silenced in tests (`test/setup.ts`). To assert on logs, use
  `vi.stubEnv("OPENCODE_QUOTA_LOG", "warn")` and a `console` spy.

## Commit and PR conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`,
  `test:`, `refactor:`, `ci:`.
- One topic per PR; describe the motivation and what users will see.
- Update `README.md` and the `## [Unreleased]` section of `CHANGELOG.md` when behavior or configuration
  changes.
- CI must be green.

## Reporting bugs and requesting features

Open an issue with a template. For anything
security-sensitive, follow [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

Releases are driven by tags:

1. Move the `## [Unreleased]` entries of `CHANGELOG.md` under a new `## [X.Y.Z] - <date>` section.
2. Bump `version` in `package.json`.
3. Commit `chore: release vX.Y.Z` and push a matching `vX.Y.Z` tag.

Pre-releases (`vX.Y.Z-rc.N`, `-alpha.N`) need steps 2 and 3 only. A version with a `-` goes to the npm
dist-tag `next` and becomes a GitHub pre-release, never "latest".

The Release workflow checks, builds, attaches `opencode-llm-quota.js` and the tarball, publishes to
npm through Trusted Publishing (an OIDC identity of this workflow, no npm token in the repository),
and copies the matching `CHANGELOG.md` section into the release
notes, falling back to generated notes when no section matches.
