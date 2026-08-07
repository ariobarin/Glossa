import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringContainsRestrictedAuthenticationData } from "../packages/protocol/src/restricted-data.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
assert.equal(listed.status, 0, listed.stderr);

const excluded = new Set(["package-lock.json"]);
const matches = [];
let scanned = 0;

for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (excluded.has(normalized)) continue;
  const buffer = await readFile(resolve(repositoryRoot, relativePath));
  if (buffer.includes(0)) continue;
  scanned += 1;
  if (stringContainsRestrictedAuthenticationData(buffer.toString("utf8"))) {
    matches.push(normalized);
  }
}

assert.deepEqual(
  matches,
  [],
  `Restricted-data detector blocks repository source files: ${matches.join(", ")}`,
);
console.log(
  `Restricted-data corpus check passed for ${scanned} working-tree text files.`,
);
