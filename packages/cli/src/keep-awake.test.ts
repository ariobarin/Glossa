import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { startKeepAwakeHelper, withKeepAwake } from "./keep-awake.js";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };

test("releases the native request on completion, failure, and cancellation", windows, async () => {
  for (const outcome of ["complete", "fail", "cancel"]) {
    const controller = new AbortController();
    let helper: ReturnType<typeof startKeepAwakeHelper> | undefined;
    const run = withKeepAwake(controller.signal, async (signal) => {
      assert.ok(helper?.pid);
      assert.equal(helper.exitCode, null);
      assert.equal(signal.aborted, false);
      if (outcome === "fail") throw new Error("session failed");
      if (outcome === "cancel") {
        controller.abort();
        assert.equal(signal.aborted, true);
      }
      return "finished";
    }, () => helper = startKeepAwakeHelper());
    if (outcome === "fail") await assert.rejects(run, /session failed/);
    else assert.equal(await run, "finished");
    assert.equal(helper?.exitCode, 0, "native helper exited cleanly after releasing the request");
  }
});

test("disconnects the session when its native wake request is lost", windows, async () => {
  let helper: ReturnType<typeof startKeepAwakeHelper>;
  await assert.rejects(withKeepAwake(new AbortController().signal, async (signal) => {
    const aborted = once(signal, "abort");
    helper.kill();
    await aborted;
  }, () => helper = startKeepAwakeHelper()), /keep-awake helper stopped/);
});

test("does not connect when the helper fails to start", { timeout: 10_000 }, async () => {
  let connected = false;
  await assert.rejects(withKeepAwake(new AbortController().signal, async () => {
    connected = true;
  }, () => spawn(process.execPath, ["-e", "process.exit(1)"], {
    stdio: ["pipe", "pipe", "ignore"],
  })), /keep-awake helper stopped/);
  assert.equal(connected, false);
});

test("cancels helper startup without waiting for readiness", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const helper = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = withKeepAwake(controller.signal, async () => assert.fail("must not connect"), () => helper);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(helper.exitCode, 0);
});

test("releases the native helper after its owner is forcibly terminated", windows, async (context) => {
  const moduleUrl = new URL("./keep-awake.ts", import.meta.url).href;
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { startKeepAwakeHelper, withKeepAwake } from ${JSON.stringify(moduleUrl)};
    let helper;
    await withKeepAwake(new AbortController().signal, async () => {
      console.log(helper.pid);
      await new Promise(() => {});
    }, () => helper = startKeepAwakeHelper());
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(owner, "close");
  context.after(() => owner.kill());
  const lines = createInterface({ input: owner.stdout });
  const [pid] = await once(lines, "line", { signal: AbortSignal.timeout(15_000) });
  lines.close();
  const helperPid = Number(pid);
  assert.ok(Number.isInteger(helperPid) && helperPid > 0);
  context.after(() => { try { process.kill(helperPid); } catch {} });
  owner.kill();
  await closed;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(helperPid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("keep-awake helper survived its owner");
});

test("rejects unsupported platforms explicitly", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(withKeepAwake(new AbortController().signal, async () => {
    assert.fail("must not connect");
  }), /only on Windows/);
});
