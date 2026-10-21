import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../dist/main.js", import.meta.url));

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function run(args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GLOSSA_RELAY_ORIGIN: "not-an-origin",
      GLOSSA_WORKER_ORIGIN: "not-an-origin",
    },
  });
}

const version = run(["--version"]);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), packageJson.version);

const help = run(["--help"]);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/);
for (const usage of [
  "glossa [--headless] [--access <read-only|workspace|system>] [--label <name>] [--keep-awake] [directory]",
  "glossa unpair",
  "glossa update [--check]",
  "glossa update --policy <notify|auto|off>",
  "glossa update --channel <beta|stable>",
  "glossa --help",
  "glossa --version",
]) {
  assert.match(help.stdout, new RegExp(usage.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(help.stdout, /\b(?:doctor|login|start|--json)\b/);

for (const retired of [
  ["doctor"],
  ["login"],
  ["start"],
  ["status", "--json"],
  ["update", "--json"],
]) {
  const result = run(retired);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Run glossa --help for usage/);
}

// Invalid access stops before pairing or a power request, on every platform.
const workspaceFlags = run(["--headless", "--keep-awake", "--access", "invalid"]);
assert.equal(workspaceFlags.status, 1, `${workspaceFlags.stdout}\n${workspaceFlags.stderr}`);
assert.match(workspaceFlags.stderr, /Access must be read-only, workspace, or system/);

console.log("CLI smoke passed for the built npm entrypoint.");
