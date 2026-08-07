import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the standalone executable path.");

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function run(args) {
  return spawnSync(executable, args, {
    encoding: "utf8",
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
  "glossa [--access <read-only|workspace|system>] [--label <name>] [directory]",
  "glossa status",
  "glossa devices revoke <id>",
  "glossa logout",
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

console.log(`Standalone smoke passed for ${executable}.`);
