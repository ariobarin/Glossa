import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandService } from "./command-service.js";
import { PathPolicy } from "./path-policy.js";

test("evicting completed commands also clears their expiry timers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-command-retention-"));
  const commands = new CommandService(await PathPolicy.create(root));
  // Observe real timers and processes rather than replacing their behavior.
  const scheduled = context.mock.method(globalThis, "setTimeout");
  const canceled = context.mock.method(globalThis, "clearTimeout");
  const expiryTimers = () => scheduled.mock.calls
    .filter((call) => call.arguments[1] === 5 * 60 * 1_000)
    .map((call) => call.result);

  try {
    for (let index = 0; index < 32; index += 1) {
      const command = await commands.start({
        argv: [process.execPath, "-e", "process.stdout.write('done')"],
        timeoutMs: 10_000,
        waitMs: 5_000,
      });
      assert.equal(command.status, "succeeded");
      assert.equal(command.stdout, "done");
      const cleared = new Set(canceled.mock.calls.map((call) => call.arguments[0]));
      const live = expiryTimers().filter((timer) => !cleared.has(timer));
      assert.equal(live.length, Math.min(index + 1, 8), "Evicted command timers remained live");
    }
    assert.equal(expiryTimers().length, 32);
  } finally {
    await commands.shutdown();
    for (const timer of expiryTimers()) clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});
