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
    {
      accessProfile: "workspace",
      workspaceLabel: "frontend",
      workerVersion: "1.0.0",
    },
  );
  state.register(accountId, deviceId, "Test PC", secondWorkerId);

  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
  assert.equal(state.workerAccessProfile(accountId, firstWorkerId), "workspace");
  assert.equal(state.workerAccessProfile(accountId, secondWorkerId), "system");
  assert.deepEqual(state.listDevices(accountId), [
    {
      deviceId: firstWorkerId,
      name: "Test PC",
      path: ".",
      workspaceLabel: "frontend",
      workerVersion: "1.0.0",
      accessProfile: "workspace",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: false,
      },
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: true,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    },
    {
      deviceId: secondWorkerId,
      name: "Test PC",
      path: ".",
      accessProfile: "system",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
      },
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: true,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    },
  ]);

  const job: WorkerJob = {
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000005",
    path: "README.md",
  };
  const poll = state.poll(
    accountId,
    deviceId,
    firstWorkerId,
    firstGeneration.generation,
    100,
  );
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
    {
      deviceId: secondWorkerId,
      name: "Test PC",
      path: ".",
      accessProfile: "system",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
      },
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: true,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    },
  ]);
});

test("reconnecting one worker does not displace another", () => {
  const state = new RouterState();
  state.register(accountId, deviceId, "Test PC", firstWorkerId);
  state.register(accountId, deviceId, "Test PC", secondWorkerId);
  state.register(accountId, deviceId, "Test PC", firstWorkerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
});

test("routes progress against the current worker generation", async () => {
  const state = new RouterState();
  state.register(accountId, deviceId, "Test PC", firstWorkerId);

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
    await state.poll(
      accountId,
      deviceId,
      firstWorkerId,
      generation.generation,
      100,
    ),
    job,
  );

  const result: WorkerResult = {
    requestId: job.requestId,
    ok: true,
    value: { status: "running" },
  };
  assert.equal(state.complete(accountId, firstWorkerId, result), true);
  assert.deepEqual(await pending, result);
});

test("invalidates worker credentials on reconnect and unregister", () => {
  const state = new RouterState();
  const first = state.register(accountId, deviceId, "Test PC", firstWorkerId);

  assert.match(first.workerToken, /^glw_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(state.authenticateWorkerToken(first.workerToken), {
    accountId,
    deviceId,
    workerId: firstWorkerId,
    generation: first.generation,
  });

  const second = state.register(accountId, deviceId, "Test PC", firstWorkerId);
  assert.equal(state.authenticateWorkerToken(first.workerToken), null);
  assert.equal(
    state.authenticateWorkerToken(second.workerToken)?.generation,
    second.generation,
  );

  state.unregisterWorker(accountId, deviceId, firstWorkerId);
  assert.equal(state.authenticateWorkerToken(second.workerToken), null);
});

test("does not unregister a newer worker generation", () => {
  const state = new RouterState();
  const first = state.register(accountId, deviceId, "Test PC", firstWorkerId);
  const second = state.register(accountId, deviceId, "Test PC", firstWorkerId);

  state.unregisterWorker(
    accountId,
    deviceId,
    firstWorkerId,
    first.generation,
  );
  assert.equal(
    state.authenticateWorkerToken(second.workerToken)?.generation,
    second.generation,
  );

  state.unregisterWorker(
    accountId,
    deviceId,
    firstWorkerId,
    second.generation,
  );
  assert.equal(state.authenticateWorkerToken(second.workerToken), null);
});

test("prunes stale workers while retaining active device counts", (context) => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  const state = new RouterState();
  const first = state.register(accountId, deviceId, "Test PC", firstWorkerId);
  const second = state.register(accountId, deviceId, "Test PC", secondWorkerId);

  now += 30_000;
  assert.equal(
    state.heartbeat(
      accountId,
      deviceId,
      firstWorkerId,
      first.generation,
    ),
    true,
  );

  now += 20_001;
  assert.equal(
    state.authenticateWorkerToken(first.workerToken)?.workerId,
    firstWorkerId,
  );
  assert.equal(state.authenticateWorkerToken(second.workerToken), null);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 1);
});


test("delivers only job types accepted by the current worker capacity", async () => {
  const state = new RouterState();
  const session = state.register(
    accountId,
    deviceId,
    "Test PC",
    firstWorkerId,
  );
  const readJob: WorkerJob = {
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000010",
    path: "README.md",
  };
  const cancelJob: WorkerJob = {
    type: "cancel_command",
    requestId: "00000000-0000-4000-8000-000000000011",
    commandId: "00000000-0000-4000-8000-000000000012",
  };

  const readPending = state.enqueue(accountId, firstWorkerId, readJob, 1_000);
  const cancelPoll = state.poll(
    accountId,
    deviceId,
    firstWorkerId,
    session.generation,
    100,
    new Set(["cancel_command"]),
  );
  const cancelPending = state.enqueue(accountId, firstWorkerId, cancelJob, 1_000);
  assert.deepEqual(await cancelPoll, cancelJob);

  assert.deepEqual(
    await state.poll(
      accountId,
      deviceId,
      firstWorkerId,
      session.generation,
      100,
      new Set(["read_file"]),
    ),
    readJob,
  );

  const cancelResult: WorkerResult = {
    requestId: cancelJob.requestId,
    ok: true,
    value: { status: "canceled" },
  };
  const readResult: WorkerResult = {
    requestId: readJob.requestId,
    ok: true,
    value: { content: "ok" },
  };
  assert.equal(state.complete(accountId, firstWorkerId, cancelResult), true);
  assert.equal(state.complete(accountId, firstWorkerId, readResult), true);
  assert.deepEqual(await cancelPending, cancelResult);
  assert.deepEqual(await readPending, readResult);
});


test("enforces declared worker access profiles before queueing jobs", async () => {
  const state = new RouterState();
  const readOnlyWorkerId = "00000000-0000-4000-8000-000000000020";
  const workspaceWorkerId = "00000000-0000-4000-8000-000000000021";
  const systemWorkerId = "00000000-0000-4000-8000-000000000022";
  state.register(accountId, deviceId, "Test PC", readOnlyWorkerId, {
    accessProfile: "read-only",
  });
  const workspaceSession = state.register(
    accountId,
    deviceId,
    "Test PC",
    workspaceWorkerId,
    { accessProfile: "workspace" },
  );
  const systemSession = state.register(
    accountId,
    deviceId,
    "Test PC",
    systemWorkerId,
    { accessProfile: "system" },
  );

  const writeJob: WorkerJob = {
    type: "write_file",
    requestId: "00000000-0000-4000-8000-000000000023",
    path: "README.md",
    content: "updated",
  };
  const commandJob: WorkerJob = {
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000024",
    argv: ["node", "--version"],
    timeoutMs: 1_000,
  };

  await assert.rejects(
    state.enqueue(accountId, readOnlyWorkerId, writeJob, 100),
    /write_access_disabled/,
  );
  await assert.rejects(
    state.enqueue(accountId, readOnlyWorkerId, commandJob, 100),
    /command_access_disabled/,
  );
  await assert.rejects(
    state.enqueue(accountId, workspaceWorkerId, commandJob, 100),
    /command_access_disabled/,
  );

  const writePoll = state.poll(
    accountId,
    deviceId,
    workspaceWorkerId,
    workspaceSession.generation,
    100,
  );
  const writePending = state.enqueue(
    accountId,
    workspaceWorkerId,
    writeJob,
    1_000,
  );
  assert.deepEqual(await writePoll, writeJob);
  const writeResult: WorkerResult = {
    requestId: writeJob.requestId,
    ok: true,
    value: { sha256: "a".repeat(64), bytes: 7 },
  };
  assert.equal(state.complete(accountId, workspaceWorkerId, writeResult), true);
  assert.deepEqual(await writePending, writeResult);

  const commandPoll = state.poll(
    accountId,
    deviceId,
    systemWorkerId,
    systemSession.generation,
    100,
  );
  const commandPending = state.enqueue(
    accountId,
    systemWorkerId,
    commandJob,
    1_000,
  );
  assert.deepEqual(await commandPoll, commandJob);
  const commandResult: WorkerResult = {
    requestId: commandJob.requestId,
    ok: true,
    value: { commandId: "00000000-0000-4000-8000-000000000025", status: "running" },
  };
  assert.equal(state.complete(accountId, systemWorkerId, commandResult), true);
  assert.deepEqual(await commandPending, commandResult);
});

test("rejects image jobs for workers without image-read capability", async () => {
  const state = new RouterState();
  const legacyWorkerId = "00000000-0000-4000-8000-000000000026";
  const session = state.register(
    accountId,
    deviceId,
    "Legacy PC",
    legacyWorkerId,
    {
      accessProfile: "read-only",
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: false,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    },
  );
  const imageJob: WorkerJob = {
    type: "view_image",
    requestId: "00000000-0000-4000-8000-000000000027",
    path: "screenshot.png",
  };

  await assert.rejects(
    state.enqueue(accountId, legacyWorkerId, imageJob, 100),
    /worker_protocol_unsupported/,
  );
  assert.equal(
    await state.poll(
      accountId,
      deviceId,
      legacyWorkerId,
      session.generation,
      5,
      new Set(["view_image"]),
    ),
    null,
  );
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
    await state.poll(
      accountId,
      deviceId,
      firstWorkerId,
      generation.generation,
      5,
    ),
    null,
  );
});
