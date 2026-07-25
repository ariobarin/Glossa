import assert from "node:assert/strict";
import test from "node:test";
import { parseInvocation, UsageError } from "./cli-options.js";

test("uses the TUI as the default workspace entrypoint", () => {
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
});

test("keeps useful direct CLI actions", () => {
  assert.deepEqual(parseInvocation(["status"]), {
    command: "status",
    json: false,
  });
  assert.deepEqual(parseInvocation(["status", "--json"]), {
    command: "status",
    json: true,
  });
  assert.deepEqual(parseInvocation(["doctor"]), {
    command: "doctor",
    json: false,
  });
  assert.deepEqual(parseInvocation(["doctor", "--json"]), {
    command: "doctor",
    json: true,
  });
  assert.deepEqual(parseInvocation(["devices"]), {
    command: "devices",
    action: "list",
    json: false,
  });
  assert.deepEqual(parseInvocation(["devices", "--json"]), {
    command: "devices",
    action: "list",
    json: true,
  });
  assert.deepEqual(parseInvocation(["devices", "revoke", "device-1"]), {
    command: "devices",
    action: "revoke",
    deviceId: "device-1",
  });
  assert.deepEqual(parseInvocation(["update"]), { command: "update" });
  assert.deepEqual(parseInvocation(["login"]), { command: "login" });
  assert.deepEqual(parseInvocation(["logout"]), { command: "logout" });
});

test("keeps standard metadata options", () => {
  assert.deepEqual(parseInvocation(["--help"]), { command: "help" });
  assert.deepEqual(parseInvocation(["-h"]), { command: "help" });
  assert.deepEqual(parseInvocation(["--version"]), { command: "version" });
  assert.deepEqual(parseInvocation(["-v"]), { command: "version" });
  assert.deepEqual(parseInvocation(["status", "--help"]), { command: "help" });
});

test("rejects malformed direct commands", () => {
  assert.throws(() => parseInvocation(["one", "two"]), UsageError);
  assert.throws(() => parseInvocation(["status", "--yaml"]), UsageError);
  assert.throws(() => parseInvocation(["doctor", "--yaml"]), UsageError);
  assert.throws(() => parseInvocation(["devices", "revoke"]), UsageError);
  assert.throws(() => parseInvocation(["logout", "--browser"]), UsageError);
});
