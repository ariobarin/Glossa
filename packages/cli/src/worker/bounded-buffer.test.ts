import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BoundedBuffer } from "./bounded-buffer.js";

test("captures only accepted bytes across block boundaries", () => {
  const capture = new BoundedBuffer(20_003);
  assert.deepEqual(capture.toBuffer(), Buffer.alloc(0));
  assert.equal(capture.append(Buffer.from("prefix")), 6);
  assert.equal(capture.append(Buffer.alloc(20_000, 0x78)), 19_997);
  assert.equal(capture.append(Buffer.from("ignored")), 0);
  assert.equal(capture.byteLength, 20_003);
  assert.deepEqual(capture.toBuffer(), Buffer.concat([
    Buffer.from("prefix"), Buffer.alloc(19_997, 0x78),
  ]));
  const short = new BoundedBuffer(20_003);
  short.append(Buffer.from("short"));
  assert.equal(short.toBuffer().toString(), "short");
});

test("tiny output chunks stay within a small memory overhead", async () => {
  if (!global.gc) {
    const child = spawnSync(process.execPath, [
      "--expose-gc", "--import", "tsx",
      "--test-name-pattern=^tiny output chunks stay within a small memory overhead$",
      fileURLToPath(import.meta.url),
    ], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const retainedMemory = async (): Promise<NodeJS.MemoryUsage> => {
    for (let pass = 0; pass < 3; pass += 1) {
      await setImmediate();
      global.gc!();
    }
    return process.memoryUsage();
  };
  const capacity = 1024 * 1024;
  const capture = new BoundedBuffer(capacity);
  const chunk = Buffer.from("x");
  const baseline = await retainedMemory();
  for (let index = 0; index < capacity; index += 1) capture.append(chunk);
  const after = await retainedMemory();
  const growth = after.heapUsed - baseline.heapUsed + after.arrayBuffers - baseline.arrayBuffers;
  assert.equal(capture.byteLength, capacity);
  assert.ok(growth < 3 * capacity, `Tiny chunks retained ${growth} bytes.`);
  assert.deepEqual(capture.toBuffer(), Buffer.alloc(capacity, 0x78));
});
