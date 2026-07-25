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
      GLOSSA_RELAY_ORIGIN: "http://127.0.0.1:9",
      GLOSSA_WORKER_ORIGIN: "http://127.0.0.1:9",
    },
  });
}

const version = run(["--version"]);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), packageJson.version);

const help = run(["--help"]);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/);
for (const command of [
  "status",
  "doctor",
  "devices",
  "update",
  "login",
  "logout",
]) {
  assert.match(help.stdout, new RegExp(`glossa ${command}`));
}
assert.doesNotMatch(help.stdout, /glossa (?:ui|completions)\b/);

const doctor = run(["doctor", "--json"]);
assert.equal(doctor.status, 1, doctor.stderr);
const doctorResult = JSON.parse(doctor.stdout);
assert.equal(doctorResult.ready, false);
assert.equal(
  doctorResult.checks.some((check) => check.name === "Node.js"),
  false,
);
assert.equal(
  doctorResult.checks.some(
    (check) => check.name === "Runtime" && check.status === "pass",
  ),
  true,
);

console.log(`Standalone smoke passed for ${executable}.`);
