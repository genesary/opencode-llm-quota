// Infrastructure for the end-to-end tests against real OpenCode binaries.
// Binaries and plugin builds are cached in `.e2e/`; HOMEs live outside this repo,
// since OpenCode snapshots the enclosing git repository as the project.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const CACHE = join(ROOT, ".e2e");
export const TOKEN = "e2e-token";

/** The Git repository of opencode-keycloak-auth, from its npm metadata unless overridden. */
function keycloakRepo(): string {
  const override = process.env["OPENCODE_KEYCLOAK_AUTH_REPO"];
  if (override) return override;
  const url = run(
    "npm",
    ["view", `opencode-keycloak-auth@${KEYCLOAK_TAG.slice(1)}`, "repository.url"],
    ROOT,
  ).trim();
  return url.replace(/^git\+/, "");
}
const KEYCLOAK_TAG = "v1.0.0";
const PATCH = join(ROOT, "patches/opencode-keycloak-auth-token-source.diff");

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function major(version: string): 1 | 2 {
  return version.startsWith("1.") ? 1 : 2;
}

/** Installs the platform binary of an OpenCode release and returns its path. */
export function opencodeBinary(version: string): string {
  const target = `${platform() === "win32" ? "windows" : platform()}-${arch()}`;
  const pkg = major(version) === 1 ? `opencode-${target}` : `@opencode/cli-${target}`;
  const dir = join(CACHE, "opencode", version);
  const bin = join(dir, "node_modules", pkg, "bin", "opencode");
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    run("npm", ["install", "--no-audit", "--no-fund", `${pkg}@${version}`], dir);
  }
  return bin;
}

/**
 * Builds this plugin and opencode-keycloak-auth (tag v1.0.0 plus the token-source
 * patch) and installs both tarballs into one folder, as the README describes.
 * Set OPENCODE_KEYCLOAK_AUTH_DIR to use a local checkout that already has the patch.
 */
export function installPlugins(): { quota: string; keycloak: string } {
  const plugins = join(CACHE, "plugins");
  mkdirSync(plugins, { recursive: true });

  run("npm", ["run", "build"], ROOT);
  const quotaTgz = join(
    plugins,
    run("npm", ["pack", "--pack-destination", plugins], ROOT).trim().split("\n").pop()!,
  );

  let keycloakDir = process.env["OPENCODE_KEYCLOAK_AUTH_DIR"];
  if (!keycloakDir) {
    const patchId = createHash("sha256").update(readFileSync(PATCH)).digest("hex").slice(0, 12);
    keycloakDir = join(CACHE, `keycloak-${KEYCLOAK_TAG}-${patchId}`);
    if (!existsSync(join(keycloakDir, "dist/index.js"))) {
      rmSync(keycloakDir, { recursive: true, force: true });
      run(
        "git",
        ["clone", "--quiet", "--depth", "1", "--branch", KEYCLOAK_TAG, keycloakRepo(), keycloakDir],
        ROOT,
      );
      run("git", ["apply", PATCH], keycloakDir);
      run("npm", ["ci", "--no-audit", "--no-fund"], keycloakDir);
      run("npm", ["run", "build"], keycloakDir);
    }
  }
  const keycloakTgz = join(
    plugins,
    run("npm", ["pack", "--pack-destination", plugins], keycloakDir).trim().split("\n").pop()!,
  );

  const target = join(plugins, "installed");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), "{}");
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", quotaTgz, keycloakTgz], target);
  return {
    quota: join(target, "node_modules/opencode-llm-quota"),
    keycloak: join(target, "node_modules/opencode-keycloak-auth"),
  };
}

export interface Home {
  dir: string;
  work: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}

/** A fresh HOME with XDG folders, a work directory and the quota plugin's log file. */
export function isolatedHome(name: string): Home {
  const dir = join(realpathSync(tmpdir()), "opencode-llm-quota-e2e", name);
  rmSync(dir, { recursive: true, force: true });
  const work = join(dir, "work");
  for (const sub of [".config/opencode", ".local/share/opencode", ".local/state", ".cache", "work"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  // Its own repository, so OpenCode never walks up into another one.
  run("git", ["init", "--quiet"], work);
  const logFile = join(dir, "quota.log");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    TERM: "xterm-256color",
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, ".local/share"),
    XDG_STATE_HOME: join(dir, ".local/state"),
    XDG_CACHE_HOME: join(dir, ".cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_QUOTA_LOG: "debug",
    OPENCODE_QUOTA_LOG_FILE: logFile,
    OPENCODE_KC_LOG: "info",
  };
  return { dir, work, env, logFile };
}

export const LABELS = { "model-a": "Model A", "model-b": "Model B" };
const MODELS = {
  "model-a": { name: "Model A" },
  "model-b": { name: "Model B" },
  "jina-embeddings-v5": { name: "Jina" },
};

/** Writes opencode.json in the v1 or v2 shape: both plugins and the platform provider. */
export function writeConfig(
  home: Home,
  version: string,
  plugins: { quota: string; keycloak: string },
  gateway: string,
  quotaOptions: Record<string, unknown> = {},
): void {
  const keycloakOptions = { issuer: "http://127.0.0.1:9/realms/e2e", clientId: "e2e" };
  const quota = { labels: LABELS, ...quotaOptions };
  const config =
    major(version) === 1
      ? {
          model: "keycloak/model-a",
          plugin: [
            [plugins.keycloak, keycloakOptions],
            [plugins.quota, quota],
          ],
          provider: {
            keycloak: {
              npm: "@ai-sdk/openai-compatible",
              name: "Platform",
              options: { baseURL: `${gateway}/v1` },
              models: MODELS,
            },
          },
        }
      : {
          model: "keycloak/model-a",
          plugins: [
            { package: plugins.keycloak, options: keycloakOptions },
            { package: plugins.quota, options: quota },
          ],
          providers: {
            keycloak: {
              name: "Platform",
              package: "@ai-sdk/openai-compatible",
              settings: { baseURL: `${gateway}/v1` },
              models: MODELS,
            },
          },
        };
  writeFileSync(join(home.dir, ".config/opencode/opencode.json"), JSON.stringify(config, null, 2));
}

/** The v1 credential opencode-keycloak-auth would have stored after a login. */
export function writeV1Credential(home: Home): void {
  const auth = { keycloak: { type: "oauth", access: TOKEN, refresh: "e2e-refresh", expires: 4102444800000 } };
  writeFileSync(join(home.dir, ".local/share/opencode/auth.json"), JSON.stringify(auth), { mode: 0o600 });
}

/** The same credential on v2, through the documented API (keycloak README, v1 to v2). */
export function v2Credential(): string {
  return JSON.stringify({
    integrationID: "keycloak",
    label: "e2e",
    activate: true,
    value: {
      type: "oauth",
      methodID: "oauth",
      access: TOKEN,
      refresh: "e2e-refresh",
      expires: 4102444800000,
    },
  });
}

/**
 * Runs an OpenCode command without blocking the event loop: the fake gateway lives
 * in this process and must keep answering while OpenCode waits on it.
 */
export function runCli(
  bin: string,
  args: string[],
  home: Home,
  timeoutMs = 180_000,
  cwd = home.work,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: home.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`timed out after ${timeoutMs} ms: opencode ${args.join(" ")}
${stderr.slice(-2000)}`),
      );
    }, timeoutMs);
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`exit ${code}: opencode ${args.join(" ")}
${stderr.slice(-2000)}`),
        );
    });
  });
}

export function start(bin: string, args: string[], home: Home): ChildProcess {
  return spawn(bin, args, { cwd: home.work, env: home.env, stdio: ["ignore", "pipe", "pipe"] });
}

export function quotaLog(home: Home): string {
  return existsSync(home.logFile) ? readFileSync(home.logFile, "utf8") : "";
}

export async function waitFor<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Resolves once nothing listens on `port` any more. */
export async function portFree(port: number, timeoutMs = 30_000): Promise<boolean> {
  const free = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resolve(false)));
      socket.once("error", () => resolve(true));
    });
  return waitFor(`port ${port} to be free`, free, timeoutMs).catch(() => false);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Python with pyte renders TUI output into a screen; TUI scenarios skip without it. */
export function terminalTools(): string | undefined {
  const venv = join(CACHE, "venv");
  const python = join(venv, "bin/python");
  try {
    if (!existsSync(python)) run("python3", ["-m", "venv", venv], ROOT);
    run(python, ["-c", "import pyte"], ROOT);
    return python;
  } catch {
    try {
      run(python, ["-m", "pip", "install", "--quiet", "pyte"], ROOT);
      return python;
    } catch {
      return undefined;
    }
  }
}

/**
 * Runs the TUI in a 160×40 pseudo-terminal for `seconds`, typing `keys` at the given
 * times, and returns the raw output and the final screen as text.
 */
export async function runTui(
  python: string,
  bin: string,
  home: Home,
  seconds: number,
  keys: Array<[number, string]> = [],
): Promise<{ raw: string; screen: string }> {
  const out = join(home.dir, `tui-${Date.now()}`);
  const keyArgs = keys.map(([at, text]) => `${at}:${text}`);
  const script = join(import.meta.dirname, "tui.py");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [script, String(seconds), out, ...keyArgs, "--", bin], {
      cwd: home.work,
      env: home.env,
      stdio: "ignore",
    });
    const timer = setTimeout(
      () => (child.kill("SIGKILL"), reject(new Error("tui.py timed out"))),
      (seconds + 30) * 1000,
    );
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`tui.py exited with ${code}`));
    });
  });
  return { raw: readFileSync(`${out}.raw`, "utf8"), screen: readFileSync(`${out}.screen`, "utf8") };
}
