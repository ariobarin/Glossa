import assert from "node:assert/strict";
import test from "node:test";
import { parseInvocation, UsageError } from "./cli-options.js";

test("uses the default invocation as the workspace entrypoint", () => {
  assert.deepEqual(parseInvocation([]), { command: "workspace" });
  assert.deepEqual(parseInvocation(["."]), {
    command: "workspace",
    path: ".",
  });
  assert.deepEqual(parseInvocation(["--", "-workspace"]), {
    command: "workspace",
    path: "-workspace",
  });
  assert.deepEqual(parseInvocation(["--", "--help"]), {
    command: "workspace",
    path: "--help",
  });
  assert.deepEqual(parseInvocation(["--", "doctor"]), {
    command: "workspace",
    path: "doctor",
  });
});

test("keeps the reduced direct CLI actions", () => {
  assert.deepEqual(parseInvocation(["status"]), { command: "status" });
  assert.deepEqual(parseInvocation(["devices", "revoke", "device-1"]), {
    command: "devices",
    action: "revoke",
    deviceId: "device-1",
  });
  assert.deepEqual(parseInvocation(["logout"]), { command: "logout" });
});

test("keeps standard metadata options", () => {
  assert.deepEqual(parseInvocation(["--help"]), { command: "help" });
  assert.deepEqual(parseInvocation(["-h"]), { command: "help" });
  assert.deepEqual(parseInvocation(["--version"]), { command: "version" });
  assert.deepEqual(parseInvocation(["-v"]), { command: "version" });
});

test("rejects malformed retained commands and removed flags", () => {
  assert.throws(() => parseInvocation(["one", "two"]), UsageError);
  assert.throws(() => parseInvocation(["status", "--json"]), UsageError);
  assert.throws(() => parseInvocation(["status", "--help"]), UsageError);
  assert.throws(() => parseInvocation(["devices"]), UsageError);
  assert.throws(() => parseInvocation(["devices", "--json"]), UsageError);
  assert.throws(() => parseInvocation(["devices", "revoke"]), UsageError);
  assert.throws(
    () => parseInvocation(["devices", "revoke", "device-1", "--json"]),
    UsageError,
  );
  assert.throws(() => parseInvocation(["logout", "--browser"]), UsageError);
});

test("rejects retired command names instead of treating them as paths", () => {
  for (const command of ["doctor", "login", "start", "update"]) {
    assert.throws(
      () => parseInvocation([command]),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === `The ${command} command is no longer available.`,
    );
  }
});
