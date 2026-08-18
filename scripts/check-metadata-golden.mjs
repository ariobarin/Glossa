import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repositoryRoot, "review", "metadata-golden.json");
const corpus = JSON.parse(await readFile(path, "utf8"));

assert.equal(corpus.version, 1, "metadata golden corpus version must be 1");
assert.ok(Array.isArray(corpus.cases), "metadata golden corpus must contain cases");
assert.ok(corpus.cases.length >= 8, "metadata golden corpus must retain broad routing coverage");

const allowedClasses = new Set(["direct", "indirect", "negative", "boundary"]);
const allowedActivations = new Set(["glossa", "none"]);
const ids = new Set();
const prompts = new Set();
const classCounts = new Map();

for (const testCase of corpus.cases) {
  assert.match(testCase.id, /^[a-z0-9][a-z0-9-]{0,63}$/, `invalid metadata case id: ${testCase.id}`);
  assert.ok(!ids.has(testCase.id), `duplicate metadata case id: ${testCase.id}`);
  ids.add(testCase.id);

  assert.equal(typeof testCase.prompt, "string", `${testCase.id} prompt must be text`);
  assert.ok(testCase.prompt.length > 0 && testCase.prompt.length <= 500, `${testCase.id} prompt is out of bounds`);
  assert.ok(!prompts.has(testCase.prompt), `duplicate metadata prompt: ${testCase.prompt}`);
  prompts.add(testCase.prompt);

  assert.ok(allowedClasses.has(testCase.class), `${testCase.id} has unsupported class`);
  classCounts.set(testCase.class, (classCounts.get(testCase.class) ?? 0) + 1);
  assert.ok(allowedActivations.has(testCase.expectedActivation), `${testCase.id} has unsupported activation`);
  assert.ok(Array.isArray(testCase.expectedTools), `${testCase.id} expectedTools must be an array`);
  assert.equal(new Set(testCase.expectedTools).size, testCase.expectedTools.length, `${testCase.id} expectedTools must be unique`);
  for (const tool of testCase.expectedTools) {
    assert.match(tool, /^[a-z][a-z0-9_]{0,63}$/, `${testCase.id} has invalid tool name: ${tool}`);
  }
  if (testCase.expectedActivation === "none") {
    assert.deepEqual(testCase.expectedTools, [], `${testCase.id} must not expect tools when activation is none`);
  }
}

for (const [name, minimum] of [["direct", 2], ["indirect", 2], ["negative", 3], ["boundary", 2]]) {
  assert.ok((classCounts.get(name) ?? 0) >= minimum, `metadata golden corpus needs at least ${minimum} ${name} cases`);
}

console.log(`Metadata golden corpus checks passed for ${corpus.cases.length} cases.`);
