import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { WorkerJob, WorkerResult } from "@glossa/protocol";
import { RouterState } from "./router-state.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const firstWorkerId = "00000000-0000-4000-8000-000000000003";
const secondWorkerId = "00000000-0000-4000-8000-000000000004";

test("routes multiple workers enrolled on one computer independently", async () => {
  const state = new RouterState();
  const firstGeneration = state.register(
    accountId,
    deviceId,
    "Test PC",
    firstWorkerId,
    { commandProgress: true },
  );
  state.register(accountId, deviceId, "Test PC", secondWorkerId);

  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
  assert.equal(state.supportsCommandProgress(accountId, firstWorkerId), true);
  assert.equal(state.supportsCommandProgress(accountId, secondWorkerId), false);
  assert.deepEqual(state.listDevices(accountId), [
    { deviceId: firstWorkerId, name: "Test PC", path: "." },
    { deviceId: secondWorkerId, name: "Test PC", path: "." },
  ]);

  const job: WorkerJob = {
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000005",
    path: "README.md",
  };
  const poll = state.poll(accountId, deviceId, firstWorkerId, firstGeneration, 100);
  const pending = state.enqueue(accountId, firstWorkerId, job, 1_000);
  assert.deepEqual(await poll, job);

  const result: WorkerResult = {
    requestId: job.requestId,
    ok: true,
    value: { content: "ok" },
  };
  assert.equal(state.complete(accountId, firstWorkerId, result), true);
  assert.deepEqual(await pending, result);

  state.unregisterWorker(accountId, deviceId, firstWorkerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 1);
  assert.deepEqual(state.listDevices(accountId), [
    { deviceId: secondWorkerId, name: "Test PC", path: "." },
  ]);
});

test("reconnecting one worker does not displace another", () => {
  const state = new RouterState();
  state.register(accountId, deviceId, "Test PC", firstWorkerId);
  state.register(accountId, deviceId, "Test PC", secondWorkerId);
  state.register(accountId, deviceId, "Test PC", firstWorkerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
});

test("filters progress against the current worker generation", async () => {
  const state = new RouterState();
  state.register(
    accountId,
    deviceId,
    "Test PC",
    firstWorkerId,
    { commandProgress: true },
  );
  assert.equal(state.supportsCommandProgress(accountId, firstWorkerId), true);

  const generation = state.register(
    accountId,
    deviceId,
    "Test PC",
    firstWorkerId,
  );
  const job: WorkerJob = {
    type: "get_command",
    requestId: "00000000-0000-4000-8000-000000000007",
    commandId: "00000000-0000-4000-8000-000000000008",
    waitMs: 25,
    afterSequence: 3,
  };
  const pending = state.enqueue(accountId, firstWorkerId, job, 1_000);
  assert.deepEqual(
    await state.poll(accountId, deviceId, firstWorkerId, generation, 100),
    {
      type: "get_command",
      requestId: job.requestId,
      commandId: job.commandId,
      waitMs: job.waitMs,
    },
  );

  const result: WorkerResult = {
    requestId: job.requestId,
    ok: true,
    value: { status: "running" },
  };
  assert.equal(state.complete(accountId, firstWorkerId, result), true);
  assert.deepEqual(await pending, result);
});

test("does not deliver a queued job after its request times out", async () => {
  const state = new RouterState();
  const generation = state.register(
    accountId,
    deviceId,
    "Test PC",
    firstWorkerId,
  );
  const job: WorkerJob = {
    type: "write_file",
    requestId: "00000000-0000-4000-8000-000000000006",
    path: "README.md",
    content: "late write",
  };

  await Promise.all([
    assert.rejects(
      state.enqueue(accountId, firstWorkerId, job, 5),
      /job_timeout/,
    ),
    delay(10),
  ]);
  assert.equal(
    await state.poll(accountId, deviceId, firstWorkerId, generation, 5),
    null,
  );
});
