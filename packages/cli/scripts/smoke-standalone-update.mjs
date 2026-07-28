import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Pass the executable path.");
}

const result = spawnSync(executable, ["update"], {
  encoding: "utf8",
});
assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
assert.match(result.stderr, /The update command is no longer available/);
assert.match(result.stderr, /Run glossa --help for usage/);

console.log(`Standalone retired-update smoke passed for ${executable}.`);
