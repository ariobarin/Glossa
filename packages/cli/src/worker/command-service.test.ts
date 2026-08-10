import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_COMMAND_OUTPUT_BYTES } from "@glossa/protocol";
import { CommandService } from "./command-service.js";
import { WorkerError } from "./errors.js";
import { PathPolicy } from "./path-policy.js";

async function commandFixture(
  context: test.TestContext,
): Promise<{ root: string; commands: CommandService }> {
  const createdRoot = await mkdtemp(
    path.join(os.tmpdir(), "glossa-command-test-"),
  );
  const policy = await PathPolicy.create(createdRoot);
  const commands = new CommandService(policy);
  context.after(async () => {
    await commands.shutdown();
    await rm(createdRoot, { force: true, recursive: true });
  });
  return { root: policy.root, commands };
}

test("normalizes unresolved direct commands as spawn failures", async (context) => {
  const { commands } = await commandFixture(context);
  await assert.rejects(
    commands.start({
      argv: ["glossa-command-that-does-not-exist"],
      timeoutMs: 10_000,
      waitMs: 0,
    }),
    (error: unknown) =>
      error instanceof WorkerError && error.code === "command_spawn_failed",
  );
});

test(
  "rejects Windows command shims with actionable shell guidance",
  { skip: process.platform !== "win32" },
  async (context) => {
    const { commands } = await commandFixture(context);
    await assert.rejects(
      commands.start({
        argv: ["npm.cmd", "--version"],
        timeoutMs: 10_000,
        waitMs: 0,
      }),
      (error: unknown) =>
        error instanceof WorkerError &&
        error.code === "windows_command_shim" &&
        /shellCommand/.test(error.message),
    );

    const native = await commands.start({
      argv: [process.execPath, "--version"],
      timeoutMs: 10_000,
      waitMs: 5_000,
    });
    assert.equal(native.status, "succeeded");
    assert.equal(native.exitCode, 0);
  },
);

test(
  "covers Windows shim variants and the documented recovery path",
  { skip: process.platform !== "win32" },
  async (context) => {
    const { commands } = await commandFixture(context);
    for (const shim of [
      "NPM.CMD",
      "tool.bat",
      "C:\\Program Files\\Tool\\tool.BAT",
    ]) {
      await assert.rejects(
        commands.start({
          argv: [shim, "--version"],
          timeoutMs: 10_000,
          waitMs: 0,
        }),
        (error: unknown) =>
          error instanceof WorkerError &&
          error.code === "windows_command_shim" &&
          /shellCommand.*explicit shim filename/.test(error.message) &&
          !error.message.includes(shim),
      );
    }

    const shimmed = await commands.start({
      shellCommand: "npm.cmd --version",
      timeoutMs: 10_000,
      waitMs: 5_000,
    });
    assert.equal(shimmed.status, "succeeded");
    assert.equal(shimmed.exitCode, 0);
    assert.match(shimmed.stdout ?? "", /^\d+\.\d+\.\d+/);
  },
);

test("returns completed output for fast commands without a second lookup", async (context) => {
  const { commands } = await commandFixture(context);
  const completed = await commands.start({
    argv: [process.execPath, "-e", "process.stdout.write('fast')"],
    timeoutMs: 10_000,
    waitMs: 5_000,
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.stdout, "fast");
});

test("returns a handle when a command outlives the fast wait", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      "setTimeout(() => process.stdout.write('later'), 250)",
    ],
    timeoutMs: 10_000,
    waitMs: 10,
  });

  assert.equal(started.status, "running");
  const completed = await commands.get(started.commandId, 15_000);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout, "later");
});

test("returns running output and wakes when command progress changes", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write('first'); setTimeout(() => process.stdout.write(' second'), 1000); setTimeout(() => {}, 1500)",
    ],
    timeoutMs: 10_000,
    waitMs: 0,
  });

  const first = await commands.get(started.commandId, 5_000, started.sequence);
  assert.equal(first.status, "running");
  assert.equal(first.stdout, "first");
  assert.ok(first.sequence > started.sequence);

  const second = await commands.get(started.commandId, 5_000, first.sequence);
  assert.equal(second.stdout, "first second");
  assert.ok(second.sequence > first.sequence);

  const completed = await commands.get(started.commandId, 5_000);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout, "first second");
  assert.ok(completed.sequence > second.sequence);
});

test("rejects a command sequence ahead of current progress", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 500)"],
    timeoutMs: 10_000,
    waitMs: 0,
  });

  await assert.rejects(
    commands.get(started.commandId, 0, started.sequence + 1),
    /sequence is invalid/,
  );
});

test("runs the platform shell inside the exposed root", async (context) => {
  const { root, commands } = await commandFixture(context);
  const started = await commands.start({
    shellCommand: process.platform === "win32"
      ? "Write-Output (Get-Location).Path"
      : "pwd",
    timeoutMs: 30_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.exitCode, 0);
  const reportedRoot = completed.stdout?.trim() ?? "";
  assert.equal(
    process.platform === "win32" ? reportedRoot.toLowerCase() : reportedRoot,
    process.platform === "win32" ? root.toLowerCase() : root,
  );
  assert.equal(completed.stderr, "");
});

test("terminates a shell process after its timeout", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    shellCommand: process.platform === "win32"
      ? "Start-Sleep -Seconds 30"
      : "sleep 30",
    timeoutMs: 100,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "timed_out");
});

test("truncates command output at a complete UTF-8 character", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write("a".repeat(${MAX_COMMAND_OUTPUT_BYTES - 1}) + "\\u20ac")`,
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout?.startsWith("a".repeat(256)), true);
  assert.equal(completed.stdout?.endsWith("\u20ac"), true);
  assert.equal(completed.stdout?.includes("\ufffd"), false);
  assert.equal(completed.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(completed.stdout ?? "") <= MAX_COMMAND_OUTPUT_BYTES);
});

test("caps replacement characters within the output budget", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write(Buffer.alloc(${MAX_COMMAND_OUTPUT_BYTES}, 0xff))`,
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout?.startsWith("\ufffd"), true);
  assert.equal(completed.stdout?.endsWith("\ufffd"), true);
  assert.equal(completed.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(completed.stdout ?? "") <= MAX_COMMAND_OUTPUT_BYTES);
});

test("retains short malformed UTF-8 diagnostics", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write(Buffer.from([0xff]))",
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout, "\ufffd");
  assert.equal(completed.stdoutTruncated, false);
  assert.equal(Buffer.byteLength(completed.stdout), 3);
});

test("shares one capture budget across standard output and error", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write("a".repeat(${MAX_COMMAND_OUTPUT_BYTES})); process.stderr.write("b")`,
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.ok(
    Buffer.byteLength(completed.stdout ?? "") +
      Buffer.byteLength(completed.stderr ?? "") <=
      MAX_COMMAND_OUTPUT_BYTES,
  );
  assert.equal(completed.stderr, "b");
  assert.equal(completed.stdoutTruncated, true);
  assert.equal(completed.stderrTruncated, false);
});

test("preserves the beginning and end of long command output", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write("HEAD-" + "x".repeat(${2 * MAX_COMMAND_OUTPUT_BYTES}) + "-TAIL")`,
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stdout?.startsWith("HEAD-"), true);
  assert.equal(completed.stdout?.endsWith("-TAIL"), true);
  assert.equal(completed.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(completed.stdout ?? "") <= MAX_COMMAND_OUTPUT_BYTES);
});

test("reserves diagnostic output when both streams are noisy", async (context) => {
  const { commands } = await commandFixture(context);
  const started = await commands.start({
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write("o".repeat(${2 * MAX_COMMAND_OUTPUT_BYTES})); process.stderr.write("ERROR-HEAD-" + "e".repeat(${MAX_COMMAND_OUTPUT_BYTES}) + "-ERROR-TAIL")`,
    ],
    timeoutMs: 10_000,
  });
  const completed = await commands.get(started.commandId, 15_000);

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.stderr?.startsWith("ERROR-HEAD-"), true);
  assert.equal(completed.stderr?.endsWith("-ERROR-TAIL"), true);
  assert.equal(completed.stdoutTruncated, true);
  assert.equal(completed.stderrTruncated, true);
  assert.ok(
    Buffer.byteLength(completed.stdout ?? "") +
      Buffer.byteLength(completed.stderr ?? "") <=
      MAX_COMMAND_OUTPUT_BYTES,
  );
});
