import assert from "node:assert/strict";
import test from "node:test";
import { parseInvocation, UsageError } from "./cli-options.js";

test("uses workspace access as the default workspace entrypoint", () => {
  assert.deepEqual(parseInvocation([]), {
    command: "workspace",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation(["."]), {
    command: "workspace",
    path: ".",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation(["--", "-workspace"]), {
    command: "workspace",
    path: "-workspace",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation(["--", "--help"]), {
    command: "workspace",
    path: "--help",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation(["--", "doctor"]), {
    command: "workspace",
    path: "doctor",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation(["--label", "frontend", "."]), {
    command: "workspace",
    path: ".",
    label: "frontend",
    accessProfile: "workspace",
  });
  assert.deepEqual(parseInvocation([".", "--label", "  API  "]), {
    command: "workspace",
    path: ".",
    label: "API",
    accessProfile: "workspace",
  });
});

test("parses explicit least-privilege and system access profiles", () => {
  assert.deepEqual(parseInvocation(["--access", "read-only", "."]), {
    command: "workspace",
    path: ".",
    accessProfile: "read-only",
  });
  assert.deepEqual(parseInvocation([".", "--access", "system"]), {
    command: "workspace",
    path: ".",
    accessProfile: "system",
  });
});

test("parses headless workspace sessions", () => {
  assert.deepEqual(
    parseInvocation([
      "--headless",
      "--access",
      "system",
      "--label",
      "recovery",
      ".",
    ]),
    {
      command: "workspace",
      path: ".",
      label: "recovery",
      headless: true,
      accessProfile: "system",
    },
  );
  assert.throws(
    () => parseInvocation(["--headless", "--headless"]),
    new UsageError("Use --headless at most once."),
  );
});

test("keeps the reduced direct CLI actions", () => {
  assert.deepEqual(parseInvocation(["unpair"]), { command: "unpair" });
  for (const retired of ["status", "devices", "logout", "login"]) {
    assert.throws(
      () => parseInvocation([retired]),
      new UsageError(`The ${retired} command is no longer available.`),
    );
  }
});

test("parses update actions and settings", () => {
  assert.deepEqual(parseInvocation(["update"]), {
    command: "update",
    action: "install",
  });
  assert.deepEqual(parseInvocation(["update", "--check"]), {
    command: "update",
    action: "check",
  });
  assert.deepEqual(parseInvocation(["update", "--policy", "auto"]), {
    command: "update",
    action: "configure",
    policy: "auto",
  });
  assert.deepEqual(
    parseInvocation(["update", "--channel", "stable", "--policy", "off"]),
    {
      command: "update",
      action: "configure",
      channel: "stable",
      policy: "off",
    },
  );
});

test("rejects invalid update options", () => {
  assert.throws(() => parseInvocation(["update", "--check", "--policy", "auto"]), UsageError);
  assert.throws(() => parseInvocation(["update", "--policy", "sometimes"]), UsageError);
  assert.throws(() => parseInvocation(["update", "--channel", "nightly"]), UsageError);
  assert.throws(() => parseInvocation(["update", "--unknown"]), UsageError);
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
  assert.throws(() => parseInvocation(["unpair", "--local"]), UsageError);
  assert.throws(() => parseInvocation(["--label"]), UsageError);
  assert.throws(() => parseInvocation(["--access"]), UsageError);
  assert.throws(() => parseInvocation(["--access", "admin"]), UsageError);
  assert.throws(
    () => parseInvocation(["--access", "workspace", "--access", "system"]),
    UsageError,
  );
  assert.throws(
    () => parseInvocation(["--label", "one", "--label", "two"]),
    UsageError,
  );
  assert.throws(
    () => parseInvocation(["--label", "x".repeat(81)]),
    UsageError,
  );
  assert.throws(
    () => parseInvocation(["--label", "bad\nlabel"]),
    UsageError,
  );
});

test("rejects retired command names instead of treating them as paths", () => {
  for (const command of ["completions", "doctor", "login", "start"]) {
    assert.throws(
      () => parseInvocation([command]),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === `The ${command} command is no longer available.`,
    );
  }
});
