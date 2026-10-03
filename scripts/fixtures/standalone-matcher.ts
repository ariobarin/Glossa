import assert from "node:assert/strict";
import { SearchMatcher } from "../../packages/cli/src/worker/search-matcher.js";

assert.ok(process.versions.bun, "The standalone executable did not enter its embedded runtime");
const exitListeners = process.listenerCount("exit");
const matcher = await SearchMatcher.create({
  query: "(?<=^)(foo) \\1$",
  includeGlobs: ["src/**/*.ts"],
  excludeGlobs: ["**/*.test.ts"],
}, 5_000);
try {
  assert.equal(await matcher.includesPath("src/nested/example.ts", 2_000), true);
  assert.equal(await matcher.includesPath("src/example.test.ts", 2_000), false);
  assert.equal(await matcher.includesPath("docs/example.md", 2_000), false);
  assert.deepEqual(await matcher.match(["other", "foo foo", "foo foo"], 1, 2_000), [[1, 0, 7]]);
} finally {
  await matcher.close();
}
assert.equal(process.listenerCount("exit"), exitListeners);
await assert.rejects(SearchMatcher.create({ query: "[" }, 5_000), { code: "invalid_search" });
assert.equal(process.listenerCount("exit"), exitListeners);

const slow = await SearchMatcher.create({ query: "(a+)+$" }, 5_000);
try {
  // Keep even a broken termination path finite on a developer's computer.
  await assert.rejects(slow.match(["a".repeat(28) + "!"], 1, 1), { code: "scan_timeout" });
} finally {
  await slow.close();
}
assert.equal(process.listenerCount("exit"), exitListeners);
console.log("Embedded runtime: regex, globs, result limits and timeout cleanup passed.");
