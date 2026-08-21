import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  nodeVersionSatisfies,
  unsupportedNodeMessage,
} from "./node-version.js";

test("accepts the supported minimum and any newer release", () => {
  assert.equal(nodeVersionSatisfies(`${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`), true);
  assert.equal(nodeVersionSatisfies(`${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.1`), true);
  assert.equal(nodeVersionSatisfies(`${MIN_NODE_MAJOR + 1}.0.0`), true);
  assert.equal(nodeVersionSatisfies("24.13.0"), true);
  assert.equal(nodeVersionSatisfies(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`), true);
});

test("rejects older releases and unparseable versions", () => {
  assert.equal(nodeVersionSatisfies(`${MIN_NODE_MAJOR}.${MIN_NODE_MINOR - 1}.0`), false);
  assert.equal(nodeVersionSatisfies(`${MIN_NODE_MAJOR - 1}.7.0`), false);
  assert.equal(nodeVersionSatisfies("garbage"), false);
  assert.equal(nodeVersionSatisfies(""), false);
});

test("the unsupported message names the running and required versions", () => {
  const message = unsupportedNodeMessage("16.20.2");
  assert.match(message, /Node\.js 18\.0 or newer/);
  assert.match(message, /running Node 16\.20\.2/);
  assert.match(message, /https:\/\/nodejs\.org\//);
});
