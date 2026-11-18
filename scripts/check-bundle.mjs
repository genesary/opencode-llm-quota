// Checks the two artifacts: Node built-ins as the only runtime imports (plus the
// host's @opentui/solid in tui.js), and default exports OpenCode v1 and v2 accept.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";

const fail = (msg) => {
  console.error(`check-bundle: ${msg}`);
  process.exit(1);
};

const js = readdirSync("dist")
  .filter((f) => f.endsWith(".js"))
  .sort();
if (js.join() !== "index.js,tui.js") fail(`expected dist/index.js and dist/tui.js, found: ${js.join(", ")}`);

const imports = (file, allowed) => {
  const source = readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  const foreign = specifiers.filter(
    (s) => !s.startsWith("node:") && !builtinModules.includes(s) && !allowed.includes(s),
  );
  if (foreign.length)
    fail(`${file}: runtime imports outside the allowed set: ${[...new Set(foreign)].join(", ")}`);
  return { size: source.length, specifiers: [...new Set(specifiers)] };
};

const server = imports("dist/index.js", []);
const tui = imports("dist/tui.js", ["@opentui/solid"]);

const plugin = (await import(pathToFileURL("dist/index.js").href)).default;
if (plugin?.id !== "opencode-llm-quota") fail(`dist/index.js default.id is ${JSON.stringify(plugin?.id)}`);
if (typeof plugin.setup !== "function") fail("dist/index.js default.setup is not a function");
if (typeof plugin.server !== "function") fail("dist/index.js default.server is not a function");

// tui.js cannot load outside the host, so check its export statically.
const tuiSource = readFileSync("dist/tui.js", "utf8");
if (!/export\s*\{[^}]*\bas default\b/.test(tuiSource) && !/export default/.test(tuiSource)) {
  fail("dist/tui.js has no default export");
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(
  `check-bundle: OK (index.js ${kib(server.size)}, imports: ${server.specifiers.join(", ") || "none"}; ` +
    `tui.js ${kib(tui.size)}, imports: ${tui.specifiers.join(", ")})`,
);
