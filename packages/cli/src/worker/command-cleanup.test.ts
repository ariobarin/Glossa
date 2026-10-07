import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CommandService } from "./command-service.js";
import { terminateProcessTree } from "./command-termination.js";
import { PathPolicy } from "./path-policy.js";

async function fixture(
  context: test.TestContext,
  terminate = terminateProcessTree,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-cleanup-"));
  const commands = new CommandService(await PathPolicy.create(root), terminate);
  context.after(async () => {
    await commands.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
  });
  return { root, commands };
}

async function heldPipes(context: test.TestContext) {
  let leaderExited = false;
  const { root, commands } = await fixture(context, async (child) => {
    leaderExited = child.exitCode !== null || child.signalCode !== null;
    await terminateProcessTree(child);
  });
  await writeFile(path.join(root, "leader.cjs"), `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('held'); setTimeout(() => {}, 10000)"
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref();
    setTimeout(() => process.exit(0), 50);
  `);
  const invocation = process.platform === "win32"
    ? { shellCommand: "Start-Process ping.exe -ArgumentList '-n','11','127.0.0.1' -NoNewWindow; Write-Output 'held'" }
    : { argv: [process.execPath, "leader.cjs"] };
  return { commands, invocation, leaderExited: () => leaderExited };
}

for (const operation of ["timeout", "cancel", "shutdown"] as const) {
  test(`exited leader with held pipes settles on ${operation}`, async (context) => {
    const { commands, invocation, leaderExited } = await heldPipes(context);
    const started = await commands.start({
      ...invocation,
      timeoutMs: operation === "timeout" ? 2000 : 30000,
      waitMs: 0,
    });
    if (operation !== "timeout") await delay(2000);
    const beforeCleanup = Date.now();
    const observed = commands.get(started.commandId, 7000);
    const action = operation === "cancel"
      ? commands.cancel(started.commandId)
      : operation === "shutdown" ? commands.shutdown() : observed;
    const results = await Promise.allSettled([action, observed]);
    const budget = operation === "timeout" ? 6500 : 4500;
    assert.ok(Date.now() - beforeCleanup < budget, "cleanup exceeded its bound");
    assert.equal(leaderExited(), true, "fixture leader must exit before cleanup");
    if (process.platform === "win32") {
      for (const result of results) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
          assert.equal(result.reason.code, "command_cleanup_failed");
        }
      }
      await assert.rejects(commands.readOutput(started.commandId, "stdout"), {
        code: "command_cleanup_failed",
      });
      await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
        code: "command_cleanup_failed",
      });
    } else {
      assert.equal((await commands.get(started.commandId)).status,
        operation === "timeout" ? "timed_out" : "canceled");
      for (const result of results) assert.equal(result.status, "fulfilled");
    }
  });
}

test("failed cleanup is shared by timeout, secret detection, cancel and shutdown", async (context) => {
  let attempts = 0;
  let cleanupStarted!: () => void;
  const began = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const { commands } = await fixture(context, async () => {
    attempts += 1;
    cleanupStarted();
    await delay(700);
    throw new Error("forced failure with private diagnostics");
  });
  const running = await commands.start({
    argv: [process.execPath, "-e",
      "setTimeout(() => process.stdout.write('sk-proj-' + 'A'.repeat(32)), 50); setTimeout(() => {}, 2000)"],
    timeoutMs: 100,
    waitMs: 0,
  });
  const waiting = commands.get(running.commandId, 5000);
  await began;
  await assert.rejects(commands.get(running.commandId, 1000, 0), {
    code: "restricted_data_blocked",
  });
  const results = await Promise.allSettled([
    commands.cancel(running.commandId),
    commands.cancel(running.commandId),
    commands.shutdown(),
    waiting,
  ]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.reason.code, "command_cleanup_failed");
      assert.doesNotMatch(result.reason.message, /private diagnostics|sk-proj-/);
    }
  }
  assert.equal(attempts, 1);
  await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
    code: "command_cleanup_failed",
  });
  await assert.rejects(commands.readOutput(running.commandId, "stdout"), {
    code: "command_cleanup_failed",
  });
});

test("close during failed cleanup cannot become canceled success", async (context) => {
  const { commands } = await fixture(context, async (child) => {
    await new Promise<void>((resolve) => child.once("close", resolve));
    throw new Error("forced termination failure after close");
  });
  const started = await commands.start({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 100)"],
    waitMs: 0,
  });
  await assert.rejects(commands.cancel(started.commandId), { code: "command_cleanup_failed" });
  await assert.rejects(commands.get(started.commandId), { code: "command_cleanup_failed" });
});

for (const otherFailure of [false, true]) {
  test(`late confirmed tree cleanup ${otherFailure ? "preserves another failure" : "restores command starts"}`, async (context) => {
    let release!: () => void;
    let confirmed!: () => void;
    let failNext = false;
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const stopped = new Promise<void>((resolve) => { confirmed = resolve; });
    const { commands } = await fixture(context, async (child) => {
      if (failNext) {
        failNext = false;
        await terminateProcessTree(child);
        throw new Error("independent cleanup failure");
      }
      await proceed;
      const closed = new Promise<void>((resolve) => child.once("close", resolve));
      await terminateProcessTree(child);
      await closed;
      confirmed();
    });
    const started = await commands.start({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      waitMs: 0,
    });
    const neighbor = otherFailure ? await commands.start({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], waitMs: 0,
    }) : undefined;
    try {
      await assert.rejects(commands.cancel(started.commandId), { code: "command_cleanup_failed" });
      await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
        code: "command_cleanup_failed",
      });
      if (neighbor) {
        failNext = true;
        await assert.rejects(commands.cancel(neighbor.commandId), { code: "command_cleanup_failed" });
      }
    } finally {
      release();
      await stopped;
    }
    await setImmediate();
    assert.equal((await commands.get(started.commandId)).status, "canceled");
    const replacement = commands.start({ argv: [process.execPath, "--version"], waitMs: 1000 });
    if (otherFailure) await assert.rejects(replacement, { code: "command_cleanup_failed" });
    else assert.equal((await replacement).status, "succeeded");
  });
}

test("a stalled termination boundary has a deadline and disables further starts", async (context) => {
  const { commands } = await fixture(context, () => new Promise<void>(() => {}));
  const neighbor = await commands.start({
    argv: [process.execPath, "-e", "setTimeout(() => process.stdout.write('independent'), 5000)"],
    waitMs: 0,
  });
  const started = await commands.start({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 6000)"],
    timeoutMs: 50,
    waitMs: 0,
  });
  const beforeCleanup = Date.now();
  await assert.rejects(commands.get(started.commandId, 5000), { code: "command_cleanup_failed" });
  assert.ok(Date.now() - beforeCleanup < 4500);
  assert.equal((await commands.get(neighbor.commandId)).status, "running");
  assert.equal((await commands.get(neighbor.commandId, 2000)).stdout, "independent");
  await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
    code: "command_cleanup_failed",
  });
});

test("spawn failure during shutdown does not become a cleanup failure", async (context) => {
  const { commands } = await fixture(context);
  const failedStart = assert.rejects(commands.start({
    argv: ["glossa-command-that-does-not-exist"],
    waitMs: 0,
  }), { code: "command_spawn_failed" });
  await commands.shutdown();
  await failedStart;
  await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
    code: "worker_shutting_down",
  });
});

test("completed cleanup preserves cancellation and the four-command limit", async (context) => {
  let attempts = 0;
  const { commands } = await fixture(context, async (child) => {
    attempts += 1;
    await new Promise<void>((resolve) => child.once("close", resolve));
  });
  const running = await Promise.all(Array.from({ length: 4 }, () => commands.start({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 1500)"],
    waitMs: 0,
  })));
  await assert.rejects(commands.start({ argv: [process.execPath, "--version"] }), {
    code: "command_busy",
  });
  const canceled = commands.cancel(running[0]!.commandId);
  assert.equal((await commands.get(running[1]!.commandId)).status, "running");
  assert.equal((await canceled).status, "canceled");
  assert.equal(attempts, 1);
  for (const neighbor of running.slice(1)) {
    assert.equal((await commands.get(neighbor.commandId, 2000)).status, "succeeded");
  }
  const next = await commands.start({ argv: [process.execPath, "--version"], waitMs: 5000 });
  assert.equal(next.status, "succeeded");
});
