import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [executable, ...prefixArgs] = process.argv.slice(2);
if (!executable) throw new Error("Pass an executable and optional entrypoint arguments.");

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function run(args) {
  return spawnSync(executable, [...prefixArgs, ...args], {
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

if (prefixArgs.length === 0) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "glossa-native-smoke-"));
  try {
    const config = path.join(temporary, "bunfig.toml");
    writeFileSync(config, "");
    const fixture = fileURLToPath(new URL("../../../scripts/fixtures/standalone-matcher.ts", import.meta.url));
    const runtime = spawnSync(path.resolve(executable), ["--no-env-file", `--config=${config}`, fixture], {
      cwd: temporary,
      encoding: "utf8",
      timeout: 20_000,
      env: { BUN_BE_BUN: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    assert.equal(runtime.status, 0, runtime.error?.message ?? runtime.stdout + runtime.stderr);
    process.stdout.write(runtime.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

console.log(`CLI smoke passed for ${[executable, ...prefixArgs].join(" ")}.`);
