import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { MAX_TEXT_BYTES, type WorkerJob } from "@glossa/protocol";
import { loadConfig } from "./config.js";
import { DevicePairingState } from "./device-pairing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { RouterState } from "./router-state.js";
import { buildRoutes, MAX_RELAY_JSON_BYTES } from "./routes.js";
import type { DeviceRecord, RelayStore } from "./store.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const workerId = "00000000-0000-4000-8000-000000000003";
const token = `gld_${deviceId}_${"a".repeat(43)}`;
const device: DeviceRecord = {
  id: deviceId,
  accountId,
  name: "Test PC",
  platform: "win32-x64",
  revokedAt: null,
  lastSeenAt: null,
};

const unused = async (): Promise<never> => {
  throw new Error("Unexpected store call.");
};

test("pairs and self-revokes a headless computer without user OAuth", async (context) => {
  let revoked = false;
  let enrollCalls = 0;
  const pairings = new DevicePairingState();
  const state = new RouterState();
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: async (requestedAccountId, name, platform) => {
      enrollCalls += 1;
      assert.equal(requestedAccountId, accountId);
      return {
        device: { ...device, name, platform },
        token,
      };
    },
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: async (requestedAccountId, requestedDeviceId) => {
      assert.equal(requestedAccountId, accountId);
      assert.equal(requestedDeviceId, deviceId);
      revoked = true;
      return true;
    },
    touchDevice: unused,
    authenticateDevice: async (requestedDeviceId) =>
      requestedDeviceId === deviceId ? device : null,
  };
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
  });
  const app = express();
  app.use(express.json());
  app.use(buildRoutes(config, store, state, { pairingState: pairings }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const started = await fetch(`${origin}/v1/device-pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "gpu-box", platform: "linux-x64" }),
  });
  assert.equal(started.status, 201);
  const challenge = await started.json() as {
    pairing_id: string;
    user_code: string;
    pairing_secret: string;
  };
  assert.match(challenge.user_code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

  assert.equal(pairings.approve(accountId, challenge.user_code).status, "approved");
  const completed = await fetch(
    `${origin}/v1/device-pairings/${challenge.pairing_id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_secret: challenge.pairing_secret }),
    },
  );
  assert.equal(completed.status, 201);
  const paired = await completed.json() as {
    device: { id: string; name: string };
    device_token: string;
  };
  assert.equal(paired.device.id, deviceId);
  assert.equal(paired.device.name, "gpu-box");
  assert.equal(paired.device_token, token);

  const retried = await fetch(
    `${origin}/v1/device-pairings/${challenge.pairing_id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_secret: challenge.pairing_secret }),
    },
  );
  assert.equal(retried.status, 201);
  const retriedPairing = await retried.json() as {
    device: { id: string; name: string };
    device_token: string;
  };
  assert.equal(retriedPairing.device.id, deviceId);
  assert.equal(retriedPairing.device_token, token);
  assert.equal(enrollCalls, 1);

  const unpaired = await fetch(`${origin}/device`, {
    method: "DELETE",
    headers: { authorization: `Device ${token}` },
  });
  assert.equal(unpaired.status, 204);
  assert.equal(revoked, true);
});

test("bounds coalesced presence writes by the relay deadline", async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  let releaseTouch!: () => void;
  const touchReleased = new Promise<void>((resolve) => {
    releaseTouch = resolve;
  });
  let touchCompleted = false;
  let observedDeadlineAt: number | undefined;
  const state = new RouterState();
  const session = state.register(
    accountId,
    deviceId,
    "Test PC",
    workerId,
  );
  state.releaseDeviceSeenPersistence(accountId, deviceId, now);
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: async () => {
      await touchReleased;
      touchCompleted = true;
      return true;
    },
    authenticateDevice: unused,
  };
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
    GLOSSA_RELAY_REQUEST_TIMEOUT_MS: "25",
  });
  const app = express();
  app.use(express.json({ limit: MAX_RELAY_JSON_BYTES }));
  app.use(buildRoutes(config, store, state, {
    beforeDeadline: async (_operation, deadlineAt) => {
      observedDeadlineAt = deadlineAt;
      throw new Error("deadline");
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address.");

  const response = await fetch(
    `http://127.0.0.1:${address.port}/device/heartbeat`,
    {
      method: "POST",
      headers: {
        authorization: `Worker ${session.workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId,
        generation: session.generation,
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );

  assert.equal(response.status, 204);
  assert.equal(observedDeadlineAt, now + 25);
  assert.equal(touchCompleted, false);
  releaseTouch();
});

test("accepts a maximum text payload after JSON escaping", async (context) => {
  const app = express();
  app.use(express.json({ limit: MAX_RELAY_JSON_BYTES }));
  app.post("/", (_request, response) => response.status(204).end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const body = JSON.stringify({ content: "\"".repeat(MAX_TEXT_BYTES) });
  const capturedStream = "\0".repeat(MAX_TEXT_BYTES);
  const commandResultBody = JSON.stringify({
    result: {
      requestId: "00000000-0000-4000-8000-000000000004",
      ok: true,
      value: { stdout: capturedStream, stderr: capturedStream },
    },
  });

  assert.ok(Buffer.byteLength(body) > 2 * MAX_TEXT_BYTES);
  assert.ok(Buffer.byteLength(commandResultBody) < MAX_RELAY_JSON_BYTES);
  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 204);
});

test("uses worker credentials without repeating device authentication", async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  let deviceAuthentications = 0;
  let deviceTouches = 0;
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: async (requestedAccountId, requestedDeviceId) => {
      deviceTouches += 1;
      return requestedAccountId === accountId && requestedDeviceId === deviceId;
    },
    authenticateDevice: async (id) => {
      deviceAuthentications += 1;
      return id === deviceId ? device : null;
    },
  };
  const state = new RouterState();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
  });
  const app = express();
  app.use(express.json());
  app.use(buildRoutes(config, store, state, {
    authFactory: () => (_request, _response, next) => next(),
    deviceRateLimiter: new FixedWindowRateLimiter(1, 60_000),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const register = async (body: object): Promise<Record<string, unknown>> => {
    const response = await fetch(`${origin}/device/register`, {
      method: "POST",
      headers: {
        authorization: `Device ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  };

  const legacy = await register({});
  const current = await register({
    workerId,
    workspaceLabel: "frontend",
    workerVersion: "1.0.0",
    accessProfile: "workspace",
    capabilities: {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      structuredMutations: true,
      commandOutputRanges: true,
    },
  });
  assert.equal(legacy.workerId, deviceId);
  assert.equal(current.workerId, workerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
  assert.equal(state.supportsCommandProgress(accountId, deviceId), false);
  assert.equal(state.supportsConcurrentJobs(accountId, deviceId), false);
  assert.equal(state.supportsStructuredReads(accountId, deviceId), false);
  assert.equal(state.supportsStructuredMutations(accountId, deviceId), false);
  assert.equal(state.supportsCommandOutputRanges(accountId, deviceId), false);
  assert.equal(state.workerAccessProfile(accountId, deviceId), "system");
  assert.equal(state.supportsFileWrites(accountId, deviceId), true);
  assert.equal(state.supportsCommands(accountId, deviceId), true);
  assert.equal(state.supportsCommandProgress(accountId, workerId), true);
  assert.equal(state.supportsConcurrentJobs(accountId, workerId), true);
  assert.equal(state.supportsStructuredReads(accountId, workerId), true);
  assert.equal(state.supportsStructuredMutations(accountId, workerId), true);
  assert.equal(state.supportsCommandOutputRanges(accountId, workerId), true);
  assert.equal(state.workerAccessProfile(accountId, workerId), "workspace");
  assert.equal(state.supportsFileWrites(accountId, workerId), true);
  assert.equal(state.supportsCommands(accountId, workerId), false);
  const currentWorker = state.listDevices(accountId)
    .find((entry) => entry.deviceId === workerId);
  assert.equal(currentWorker?.workspaceLabel, "frontend");
  assert.equal(currentWorker?.workerVersion, "1.0.0");
  assert.equal(currentWorker?.accessProfile, "workspace");
  assert.deepEqual(currentWorker?.permissions, {
    readFiles: true,
    writeFiles: true,
    runCommands: false,
  });
  assert.deepEqual(currentWorker?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
    structuredMutations: true,
    commandOutputRanges: true,
  });
  assert.equal(deviceAuthentications, 2);
  assert.equal(typeof current.workerToken, "string");
  assert.equal(typeof current.generation, "string");
  assert.equal(legacy.accessProfile, "system");
  assert.equal(current.accessProfile, "workspace");
  assert.equal(current.workspaceLabel, "frontend");
  assert.deepEqual(current.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
    structuredMutations: true,
    commandOutputRanges: true,
  });
  const workerAuthorization = `Worker ${String(current.workerToken)}`;

  const mismatched = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workerId: deviceId,
      generation: current.generation,
    }),
  });
  assert.equal(mismatched.status, 409);

  const invalidWorker = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Worker glw_${"z".repeat(43)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, generation: current.generation }),
  });
  assert.equal(invalidWorker.status, 401);
  assert.equal(deviceAuthentications, 2);

  const heartbeat = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, generation: current.generation }),
  });
  assert.equal(heartbeat.status, 204);

  const job: WorkerJob = {
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000005",
    path: "README.md",
  };
  const pending = state.enqueue(accountId, workerId, job, 1_000);
  const poll = await fetch(`${origin}/device/poll`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workerId,
      generation: current.generation,
      acceptedTypes: ["read_file"],
      waitMs: 5_000,
    }),
  });
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), { job });

  const result = {
    requestId: job.requestId,
    ok: true,
    value: { content: "ok" },
  };
  const posted = await fetch(`${origin}/device/result`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, result }),
  });
  assert.equal(posted.status, 202);
  assert.deepEqual(await posted.json(), { accepted: true });
  assert.deepEqual(await pending, result);

  const repeated = await fetch(`${origin}/device/result`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, result }),
  });
  assert.equal(repeated.status, 202);
  assert.deepEqual(await repeated.json(), { accepted: false });
  assert.equal(deviceAuthentications, 2);
  assert.equal(deviceTouches, 0);

  const legacyHeartbeat = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Device ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workerId: deviceId,
      generation: legacy.generation,
    }),
  });
  assert.equal(legacyHeartbeat.status, 204);
  assert.equal(deviceAuthentications, 3);

  now += 30_000;
  const firstPresenceHeartbeat = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, generation: current.generation }),
  });
  assert.equal(firstPresenceHeartbeat.status, 204);
  assert.equal(deviceTouches, 0);

  now += 30_001;
  const persistedPresenceHeartbeat = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, generation: current.generation }),
  });
  assert.equal(persistedPresenceHeartbeat.status, 204);
  assert.equal(deviceTouches, 1);

  const unregistered = await fetch(`${origin}/device/unregister`, {
    method: "POST",
    headers: {
      authorization: workerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId }),
  });
  assert.equal(unregistered.status, 204);
  assert.equal(state.authenticateWorkerToken(String(current.workerToken)), null);
});
