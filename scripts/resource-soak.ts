// In-process worker soak. HTTP, OAuth and Postgres are covered by integration:smoke.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_RETAINED_STREAM_BYTES,
  MAX_READ_FILE_RANGE_BYTES,
  MAX_TEXT_BYTES,
  type WorkerJob,
} from "@glossa/protocol";
import { LocalWorker } from "../packages/cli/src/worker/local-worker.js";
import { createResourceFiles } from "./fixtures/resource-files.js";

const MiB = 1024 * 1024;
const reads = Number(process.env.GLOSSA_SOAK_READS ?? 100_000);
assert.ok(Number.isInteger(reads) && reads >= 100 && reads % 10 === 0,
  "GLOSSA_SOAK_READS must be a multiple of ten, at least 100");
assert.ok(global.gc, "Run with --expose-gc and --max-old-space-size=96");
const root = await mkdtemp(path.join(os.tmpdir(), "glossa-resource-soak-"));
const worker = await LocalWorker.create(root, "system");
const startedAt = performance.now();
let fileReads = 0;
let commandStarts = 0;

async function sample(label: string) {
  for (let pass = 0; pass < 3; pass += 1) {
    await setImmediate();
    global.gc!();
  }
  const { heapUsed, rss, arrayBuffers, external } = process.memoryUsage();
  const memory = { heapUsed, rss, arrayBuffers, external };
  console.log(JSON.stringify({ label, fileReads, commandStarts,
    elapsedSeconds: Math.round((performance.now() - startedAt) / 1000), ...memory }));
  return memory;
}

async function readBatch(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const ranged = index % 2 === 1;
    const job: WorkerJob = ranged
      ? {
        requestId: "soak", type: "read_file_range", path: "limit.txt",
        startLine: 1, lineCount: 64, timeoutMs: 8_000,
      }
      : { requestId: "soak", type: "read_file", path: "limit.txt" };
    const result = await worker.handle(job);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.error));
    if (!result.ok) throw new Error("read failed");
    const value = result.value as { bytes: number; content: string; nextLine?: number };
    assert.equal(value.bytes, MAX_TEXT_BYTES);
    assert.equal(Buffer.byteLength(value.content), ranged ? 65_535 : MAX_TEXT_BYTES);
    if (ranged) assert.equal(value.nextLine, 65);
    fileReads += 1;
    if (fileReads % 5_000 === 0) console.log(JSON.stringify({ fileReads }));
  }
}

async function outputBatch(): Promise<string> {
  let first = "";
  let latest = "";
  const bytes = MAX_COMMAND_RETAINED_STREAM_BYTES + 65_536;
  for (let index = 0; index < 10; index += 1) {
    const started = await worker.commands.start({
      argv: [process.execPath, "-e",
        `process.stdout.write('x'.repeat(${bytes})); process.stderr.write('y'.repeat(${bytes}))`],
      waitMs: 5_000,
    });
    commandStarts += 1;
    const done = await worker.commands.get(started.commandId, 15_000);
    assert.equal(done.status, "succeeded");
    assert.equal(done.stdoutTruncated, true);
    assert.equal(done.stderrTruncated, true);
    assert.ok(Buffer.byteLength(done.stdout! + done.stderr!) <= MAX_COMMAND_OUTPUT_BYTES);
    for (const stream of ["stdout", "stderr"] as const) {
      const output = await worker.commands.readOutput(done.commandId, stream, 0, 65_536);
      assert.equal(output.retainedBytes, MAX_COMMAND_RETAINED_STREAM_BYTES);
      assert.equal(output.totalBytes, bytes);
      assert.equal(output.retentionTruncated, true);
      assert.equal(output.content.length, 65_536);
      assert.equal(output.nextOffset, 65_536);
    }
    first ||= done.commandId;
    latest = done.commandId;
  }
  await assert.rejects(worker.commands.get(first), { code: "command_not_found" });
  return latest;
}

try {
  await createResourceFiles(root);
  for (const [name, code] of [["over.txt", "file_too_large"], ["long-over.txt", "line_too_large"]]) {
    const result = await worker.handle({
      requestId: "negative", type: name === "over.txt" ? "read_file" : "read_file_range",
      path: name!, timeoutMs: 8_000,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error?.code, code);
  }
  const long = await worker.files.readTextRange("long-limit.txt", 1, 2);
  assert.equal(long.contentBytes, MAX_READ_FILE_RANGE_BYTES);
  assert.equal(long.nextLine, 2);
  await readBatch(1_000);
  await outputBatch();
  const baseline = await sample("warmup");
  const samples = [];
  let latest = "";
  for (let batch = 1; batch <= 5; batch += 1) {
    await readBatch(reads / 5);
    latest = await outputBatch();
    const memory = await sample(`batch-${batch}`);
    samples.push(memory);
    for (const [metric, budget] of Object.entries({
      heapUsed: 8 * MiB, arrayBuffers: 4 * MiB, external: 8 * MiB, rss: 96 * MiB,
    })) {
      const key = metric as keyof typeof memory;
      assert.ok(memory[key] - baseline[key] <= budget, `${metric} grew beyond ${budget} bytes`);
    }
    assert.ok(memory.heapUsed < 64 * MiB && memory.rss < 192 * MiB,
      "absolute process memory budget exceeded");
    assert.ok(memory.arrayBuffers < 24 * MiB, "retained buffer budget exceeded");
  }
  for (const [metric, budget] of Object.entries({
    heapUsed: 4 * MiB, arrayBuffers: 2 * MiB, external: 4 * MiB, rss: 64 * MiB,
  })) {
    const key = metric as keyof typeof baseline;
    const values = samples.slice(-3).map((memory) => memory[key]);
    assert.ok(Math.max(...values) - Math.min(...values) <= budget, `${metric} did not plateau`);
  }

  // Real wall-clock expiry, not fake timers. Sample idle retention every 30 seconds.
  const idleBaseline = await sample("idle-start");
  for (let tick = 1; tick <= 11; tick += 1) {
    await delay(30_000);
    const memory = await sample(`idle-${tick}`);
    assert.ok(memory.heapUsed - idleBaseline.heapUsed < 4 * MiB, "idle heap growth");
    assert.ok(memory.arrayBuffers - idleBaseline.arrayBuffers < 2 * MiB, "idle buffer growth");
    assert.ok(memory.rss - idleBaseline.rss < 64 * MiB, "idle RSS growth");
  }
  await assert.rejects(worker.commands.get(latest), { code: "command_not_found" });
  const expired = await sample("expired");
  assert.ok(idleBaseline.arrayBuffers - expired.arrayBuffers > 12 * MiB,
    "expired records retained output buffers");
  console.log(JSON.stringify({ result: "passed", fileReads, commandStarts,
    fullReadBytes: MAX_TEXT_BYTES, rangeBytes: 65_535 }));
} finally {
  await worker.shutdown();
  await rm(root, { recursive: true, force: true });
}
