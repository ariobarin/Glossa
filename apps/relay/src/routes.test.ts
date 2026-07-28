import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { MAX_TEXT_BYTES, type WorkerJob } from "@glossa/protocol";
import { loadConfig } from "./config.js";
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

test("bounds coalesced presence writes by the relay deadline", async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
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
      await new Promise((resolve) => setTimeout(resolve, 250));
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
  app.use(buildRoutes(config, store, state));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address.");

  const startedAt = performance.now();
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
    },
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(response.status, 204);
  assert.ok(elapsedMs < 150, `presence refresh took ${elapsedMs}ms`);
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
    capabilities: { commandProgress: true },
  });
  assert.equal(legacy.workerId, deviceId);
  assert.equal(current.workerId, workerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 2);
  assert.equal(state.supportsCommandProgress(accountId, deviceId), false);
  assert.equal(state.supportsCommandProgress(accountId, workerId), true);
  assert.equal(deviceAuthentications, 2);
  assert.equal(typeof current.workerToken, "string");
  assert.equal(typeof current.generation, "string");
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
    body: JSON.stringify({ workerId, generation: current.generation }),
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
  assert.deepEqual(await pending, result);
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
