import assert from "node:assert/strict";
import test from "node:test";
import { workspaceIdentity } from "./workspace-identity.js";

const deviceId = "00000000-0000-4000-8000-000000000001";

test("derives a stable workspace UUID", () => {
  const first = workspaceIdentity(deviceId, "C:\\Code\\Glossa", "win32");
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(
    first,
    workspaceIdentity(deviceId.toUpperCase(), "c:\\code\\glossa", "win32"),
  );
  assert.notEqual(
    first,
    workspaceIdentity(deviceId, "C:\\Code\\Other", "win32"),
  );
});

test("preserves case-sensitive roots", () => {
  assert.notEqual(
    workspaceIdentity(deviceId, "/Code/Glossa", "linux"),
    workspaceIdentity(deviceId, "/code/glossa", "linux"),
  );
});
