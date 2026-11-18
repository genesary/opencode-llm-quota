// End-to-end tests against real OpenCode binaries (v1 and v2), with
// opencode-keycloak-auth (v1.0.0 + token-source patch) and a fake gateway.
// Run with `npm run test:e2e`; pick versions with E2E_VERSIONS=1.17.11,2.3.2.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { budget, softBudgetModel, SOFT_BUDGET_REAL, HARD_CAPS_REAL } from "../fixtures.js";
import { startGateway, type Gateway } from "./fake-gateway.js";
import {
  installPlugins,
  portFree,
  isolatedHome,
  major,
  opencodeBinary,
  quotaLog,
  runCli,
  runTui,
  sleep,
  start,
  terminalTools,
  TOKEN,
  v2Credential,
  waitFor,
  writeConfig,
  writeV1Credential,
  type Home,
} from "./harness.js";

const VERSIONS = (process.env["E2E_VERSIONS"] ?? "1.17.11,1.19.6,2.0.25,2.3.2")
  .split(",")
  .map((v) => v.trim());
const SI = "model-a";
const SSI = "model-b";
const LOW = "Model A · low priority · normal in ~3 min";
const V2_SERVICE_PORT = 49374;

let plugins: { quota: string; keycloak: string };
let python: string | undefined;

beforeAll(() => {
  plugins = installPlugins();
  python = terminalTools();
}, 600_000);

const reads = (gw: Gateway, model?: string) =>
  gw.calls().filter((c) => c.path === "/v1/quota" && (!model || c.model === model));

/** Tool results the model received, as text, from the recorded chat requests. */
const toolResults = (gw: Gateway): string =>
  gw
    .calls()
    .filter((c) => c.path === "/v1/chat/completions")
    .flatMap((c) => (JSON.parse(c.body) as { messages: Array<{ role: string; content: unknown }> }).messages)
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

// Terminal escape sequences; ESC (\x1b) is the character being matched.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g;

/** Terminal output without escape sequences, so text split by styling still matches. */
const plain = (raw: string): string => raw.replace(ESCAPES, "");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Collects the text of an SSE stream until `stop()` is called. */
function collect(url: string): { text: () => string; stop: () => void } {
  let text = "";
  const abort = new AbortController();
  void fetch(url, { signal: abort.signal })
    .then(async (res) => {
      const decoder = new TextDecoder();
      for await (const chunk of res.body!) text += decoder.decode(chunk as Uint8Array, { stream: true });
    })
    .catch(() => {});
  return { text: () => text, stop: () => abort.abort() };
}

describe.each(VERSIONS.filter((v) => major(v) === 1))("OpenCode %s (v1)", (version) => {
  let bin: string;
  let home: Home;
  let gw: Gateway;
  let serve: ChildProcess | undefined;
  let server: string;

  beforeAll(async () => {
    bin = opencodeBinary(version);
    home = isolatedHome(`v${version}`);
    gw = await startGateway({ token: TOKEN, quota: { [SI]: SOFT_BUDGET_REAL, [SSI]: HARD_CAPS_REAL } });
    writeConfig(home, version, plugins, gw.url);
    writeV1Credential(home);
    const port = await freePort();
    server = `http://127.0.0.1:${port}`;
    serve = start(bin, ["serve", "--port", String(port)], home);
    await waitFor(
      "the v1 server",
      async () => (await fetch(`${server}/config`).catch(() => undefined))?.ok,
      60_000,
    );
    // v1 creates the project instance, and loads the plugins, on the first request for a directory.
    await fetch(`${server}/config?directory=${encodeURIComponent(home.work)}`);
  }, 300_000);

  afterAll(async () => {
    serve?.kill("SIGKILL");
    await gw?.close();
  });

  it("sends nothing before opencode-keycloak-auth has a token", async () => {
    await waitFor("the plugin to start", () => /started \(v1\)/.test(quotaLog(home)), 60_000);
    await sleep(5_000);
    expect(reads(gw)).toHaveLength(0);
  }, 90_000);

  it("reads the quota of the model after its response, with the keycloak token, and toasts", async () => {
    const events = collect(`${server}/event`);
    await runCli(bin, ["run", "--attach", server, "--model", `keycloak/${SI}`, "hello"], home);
    const read = await waitFor("a quota read of Model A", () => reads(gw, SI)[0], 20_000);
    expect(read.authorization).toBe(`Bearer ${TOKEN}`);
    await waitFor("the low-priority toast", () => events.text().includes(LOW), 20_000);
    events.stop();
  }, 120_000);

  it("reads the other models soon after the token appears", async () => {
    await waitFor("a quota read of Model B", () => reads(gw, SSI)[0], 30_000);
  }, 60_000);

  it("answers the quota tool with every model", async () => {
    await runCli(
      bin,
      ["run", "--attach", server, "--model", `keycloak/${SI}`, "please use the quota tool"],
      home,
    );
    const result = await waitFor("the tool result", () => toolResults(gw) || undefined, 30_000);
    expect(result).toContain(`Quotas · ${gw.url}`);
    expect(result).toContain("low priority · normal in ~3 min");
    expect(result).toContain("today 68% · resets in 10h");
  }, 120_000);

  it("shows the toast in the v1 TUI (no status bar on v1)", async (ctx) => {
    if (!python) return ctx.skip();
    serve?.kill("SIGKILL");
    serve = undefined;
    const { raw } = await runTui(python, bin, home, 35, [
      [12, "hello"],
      [13, "\r"],
    ]);
    expect(plain(raw)).toContain("low priority");
  }, 120_000);
});

describe.each(VERSIONS.filter((v) => major(v) === 2))("OpenCode %s (v2)", (version) => {
  let bin: string;
  let home: Home;
  let gw: Gateway;

  beforeAll(async () => {
    bin = opencodeBinary(version);
    home = isolatedHome(`v${version}`);
    gw = await startGateway({ token: TOKEN, quota: { [SI]: SOFT_BUDGET_REAL, [SSI]: HARD_CAPS_REAL } });
    // A long interval separates periodic reads from the read after a response.
    writeConfig(home, version, plugins, gw.url, { intervalSeconds: 300 });
    // Every v2 HOME shares the managed service port: a leftover service would answer instead.
    if (!(await portFree(V2_SERVICE_PORT))) {
      throw new Error(`port ${V2_SERVICE_PORT} is taken: stop the other OpenCode v2 service first`);
    }
    await runCli(bin, ["service", "start"], home);
    await runCli(bin, ["api", "POST", "/api/credential", "-d", v2Credential()], home);
  }, 300_000);

  afterAll(async () => {
    await runCli(bin, ["service", "stop"], home).catch(() => "");
    await portFree(V2_SERVICE_PORT);
    await gw?.close();
  });

  it("loads the server and TUI parts", async () => {
    type Listing = {
      data: Array<{ id: string; features: Record<string, boolean>; state: { status: string } }>;
    };
    // External plugins load asynchronously after the location opens.
    const quota = await waitFor(
      "the quota plugin in /api/plugin",
      async () =>
        (JSON.parse(await runCli(bin, ["api", "GET", "/api/plugin"], home)) as Listing).data.find(
          (p) => p.id === "opencode-llm-quota",
        ),
      60_000,
    );
    expect(quota?.state.status).toBe("active");
    expect(quota?.features).toEqual({ server: true, tui: true });
  }, 60_000);

  it("reads every model once with the host's token, even with two locations open", async () => {
    await runCli(bin, ["api", "GET", "/api/plugin"], home, 60_000, home.dir);
    await waitFor("reads of both models", () => reads(gw, SI)[0] && reads(gw, SSI)[0], 60_000);
    await sleep(20_000);
    expect(reads(gw, SI)).toHaveLength(1);
    expect(reads(gw, SSI)).toHaveLength(1);
    expect(reads(gw, "jina-embeddings-v5")).toHaveLength(1);
    expect(reads(gw).every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
  }, 120_000);

  it("answers the quota tool", async () => {
    await runCli(bin, ["run", "--auto", "--model", `keycloak/${SSI}`, "please use the quota tool"], home);
    const result = await waitFor(
      "the tool result",
      () => toolResults(gw).includes("Quotas") && toolResults(gw),
      30_000,
    );
    expect(result).toContain(`Quotas · ${gw.url}`);
    expect(result).toContain("Model B (model-b)");
  }, 120_000);

  it("reads a model again after its response, not before a minute after the last read", async () => {
    const last = reads(gw, SSI).at(-1)!.at;
    const next = await waitFor(
      "a read of Model B after the response",
      () => reads(gw, SSI).find((c) => c.at > last),
      90_000,
    );
    expect(next.at - last).toBeGreaterThanOrEqual(59_000);
    // Well before the 300 s periodic read.
    expect(next.at - last).toBeLessThan(120_000);
  }, 120_000);

  it("shows /quota in a dialog", async (ctx) => {
    if (!python) return ctx.skip();
    const { screen } = await runTui(python, bin, home, 25, [
      [14, "/quota"],
      [16, "\r"],
    ]);
    expect(screen).toContain(`Quotas · ${gw.url}`);
    expect(screen).toContain("Model B (model-b)");
  }, 120_000);

  it("shows the selected model in the status bar and toasts on a change", async (ctx) => {
    if (!python) return ctx.skip();
    gw.setQuota(SI, softBudgetModel(budget(372, { over: false })));
    // The response in the TUI triggers a read only a minute after the previous one.
    const wait = reads(gw, SI).at(-1)!.at + 62_000 - Date.now();
    if (wait > 0) await sleep(wait);
    const { raw, screen } = await runTui(python, bin, home, 40, [
      [12, "hello"],
      [13, "\r"],
    ]);
    expect(screen).toContain("Model A · normal priority · budget 62% left");
    expect(plain(raw)).toContain("back to normal priority");
  }, 180_000);
});
