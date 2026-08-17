import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { MAX_TEXT_BYTES, type WorkerJob } from "@glossa/protocol";
import type { AuthenticatedRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { RouterState } from "./router-state.js";
import { buildRoutes, MAX_RELAY_JSON_BYTES } from "./routes.js";
import type { DeviceRecord, PairingRecord, RelayStore } from "./store.js";

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
const unusedStore: RelayStore = {
  accountIdForSubject: unused,
  enrollDevice: unused,
  listDevices: unused,
  renameDevice: unused,
  revokeDevice: unused,
  touchDevice: unused,
  authenticateDevice: unused,
  createPairing: unused,
  findPairing: unused,
  claimPairing: unused,
  redeemPairing: unused,
};

test("serves the exact OpenAI apps challenge only when configured", async (context) => {
  const challenge = "openai-plugin-domain-challenge-test";
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
    GLOSSA_OPENAI_APPS_CHALLENGE: challenge,
  });
  const app = express();
  app.use(buildRoutes(config, unusedStore, new RouterState()));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const response = await fetch(
    `http://127.0.0.1:${address.port}/.well-known/openai-apps-challenge`,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), challenge);
});

test("keeps the OpenAI apps challenge unavailable when not configured", async (context) => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
  });
  const app = express();
  app.use(buildRoutes(config, unusedStore, new RouterState()));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const response = await fetch(
    `http://127.0.0.1:${address.port}/.well-known/openai-apps-challenge`,
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "");
});

test("enrolls a device with temporary browser authorization", async (context) => {
  const subject = "google-oauth2|published-cli";
  let invokedScope: string | undefined;
  const store: RelayStore = {
    accountIdForSubject: async (received) => {
      assert.equal(received, subject);
      return accountId;
    },
    enrollDevice: async (receivedAccountId, name, platform) => {
      assert.equal(receivedAccountId, accountId);
      assert.equal(name, "Published CLI");
      assert.equal(platform, "win32-x64");
      return { device: { ...device, name, platform }, token };
    },
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: unused,
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
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
  app.use(buildRoutes(config, store, new RouterState(), {
    authFactory: (_config, scope) => {
      return (request, _response, next) => {
        invokedScope = scope;
        (request as AuthenticatedRequest).auth = {
          subject,
          scopes: new Set(scope ? [scope] : []),
          claims: {},
        };
        next();
      };
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/devices/enroll`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Published CLI", platform: "win32-x64" }),
    },
  );

  assert.equal(invokedScope, config.GLOSSA_DEVICE_ENROLL_SCOPE);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    device: {
      id: deviceId,
      name: "Published CLI",
      platform: "win32-x64",
      lastSeenAt: null,
      revokedAt: null,
      activeWorkers: 0,
    },
    device_token: token,
  });
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
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
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
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
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

  const retiredRegistration = await fetch(`${origin}/device/register`, {
    method: "POST",
    headers: {
      authorization: `Device ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(retiredRegistration.status, 400);

  const current = await register({
    workerId,
    workspaceLabel: "frontend",
    workerVersion: "1.0.0",
    accessProfile: "workspace",
    capabilities: {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      imageReads: true,
      structuredMutations: true,
      commandOutputRanges: true,
    },
  });
  assert.equal(current.workerId, workerId);
  assert.equal(state.activeWorkerCount(accountId, deviceId), 1);
  assert.equal(state.workerAccessProfile(accountId, workerId), "workspace");
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
    imageReads: true,
    structuredMutations: true,
    commandOutputRanges: true,
  });
  assert.equal(deviceAuthentications, 2);
  assert.equal(typeof current.workerToken, "string");
  assert.equal(typeof current.generation, "string");
  assert.equal(current.accessProfile, "workspace");
  assert.equal(current.workspaceLabel, "frontend");
  assert.deepEqual(current.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
    imageReads: true,
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

test("rejects a worker revoked during device authentication", async (context) => {
  let authenticationStarted!: () => void;
  let finishAuthentication!: () => void;
  const started = new Promise<void>((resolve) => {
    authenticationStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishAuthentication = resolve;
  });
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: async () => {
      authenticationStarted();
      await finish;
      return device;
    },
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
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
  app.use(buildRoutes(config, store, state));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const registration = fetch(
    `http://127.0.0.1:${address.port}/device/register`,
    {
      method: "POST",
      headers: {
        authorization: `Device ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId,
        accessProfile: "workspace",
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
          imageReads: true,
          structuredMutations: true,
          commandOutputRanges: true,
        },
      }),
    },
  );
  await started;
  state.unregisterDevice(deviceId);
  finishAuthentication();

  const response = await registration;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_device" });
  assert.equal(state.activeWorkerCount(accountId, deviceId), 0);
});

test("manages devices with a paired device credential", async (context) => {
  const otherDevice: DeviceRecord = {
    id: "00000000-0000-4000-8000-000000000009",
    accountId,
    name: "Laptop",
    platform: null,
    revokedAt: null,
    lastSeenAt: null,
  };
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: async (receivedAccountId) => {
      assert.equal(receivedAccountId, accountId);
      return [device, otherDevice];
    },
    renameDevice: async (receivedAccountId, receivedDeviceId, name) => {
      assert.equal(receivedAccountId, accountId);
      return receivedDeviceId === otherDevice.id
        ? { ...otherDevice, name }
        : null;
    },
    revokeDevice: async (receivedAccountId, receivedDeviceId) =>
      receivedAccountId === accountId && receivedDeviceId === otherDevice.id,
    touchDevice: unused,
    authenticateDevice: async (receivedDeviceId, secret) =>
      receivedDeviceId === deviceId && secret === "a".repeat(43) ? device : null,
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
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
  app.use(buildRoutes(config, store, new RouterState(), {
    authFactory: () => (_request, response) => {
      response.status(401).json({ error: "authentication_required" });
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const authorization = `Device ${token}`;

  const listed = await fetch(`${origin}/v1/devices`, {
    headers: { authorization },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    devices: [
      {
        id: deviceId,
        name: "Test PC",
        platform: "win32-x64",
        lastSeenAt: null,
        revokedAt: null,
        activeWorkers: 0,
      },
      {
        id: otherDevice.id,
        name: "Laptop",
        platform: null,
        lastSeenAt: null,
        revokedAt: null,
        activeWorkers: 0,
      },
    ],
  });

  const renamed = await fetch(`${origin}/v1/devices/${otherDevice.id}`, {
    method: "PATCH",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed Laptop" }),
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), {
    device: {
      id: otherDevice.id,
      name: "Renamed Laptop",
      platform: null,
      lastSeenAt: null,
      revokedAt: null,
      activeWorkers: 0,
    },
  });

  const revoked = await fetch(`${origin}/v1/devices/${otherDevice.id}`, {
    method: "DELETE",
    headers: { authorization },
  });
  assert.equal(revoked.status, 204);

  const missing = await fetch(
    `${origin}/v1/devices/00000000-0000-4000-8000-000000000099`,
    {
      method: "DELETE",
      headers: { authorization },
    },
  );
  assert.equal(missing.status, 404);

  const invalid = await fetch(`${origin}/v1/devices`, {
    headers: { authorization: `Device gld_${deviceId}_${"b".repeat(43)}` },
  });
  assert.equal(invalid.status, 401);

  const enrolled = await fetch(`${origin}/v1/devices/enroll`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "Sneaky", platform: null }),
  });
  assert.equal(enrolled.status, 401);
});

test("issues a pairing code and keeps redemption pending until claimed", async (context) => {
  let codeHash: Buffer | null = null;
  const pairing: PairingRecord = {
    id: "00000000-0000-4000-8000-000000000010",
    deviceName: "",
    platform: null,
    accountId: null,
    expiresAt: new Date(0),
  };
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: unused,
    createPairing: async (id, receivedHash, deviceName, platform, expiresAt) => {
      pairing.id = id;
      pairing.deviceName = deviceName;
      pairing.platform = platform;
      pairing.expiresAt = expiresAt;
      codeHash = receivedHash;
    },
    findPairing: async (receivedHash) =>
      codeHash && receivedHash.equals(codeHash) ? pairing : null,
    claimPairing: unused,
    redeemPairing: unused,
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
  app.use(buildRoutes(config, store, new RouterState(), {
    authFactory: () => (_request, _response, next) => next(),
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${origin}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test PC", platform: "win32-x64" }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.match(createdBody.code, /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
  const expiresAt = Date.parse(createdBody.expiresAt);
  assert.ok(expiresAt > Date.now() + 9 * 60_000);
  assert.ok(expiresAt <= Date.now() + 10 * 60_000);
  assert.equal(pairing.deviceName, "Test PC");
  assert.equal(pairing.platform, "win32-x64");

  const pending = await fetch(`${origin}/v1/pairings/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: createdBody.code.toLowerCase() }),
  });
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: "pending" });

  const unknown = await fetch(`${origin}/v1/pairings/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ABCD-EFGH" }),
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "pairing_not_found" });

  const malformed = await fetch(`${origin}/v1/pairings/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "not-a-code" }),
  });
  assert.equal(malformed.status, 404);

  const invalid = await fetch(`${origin}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(invalid.status, 400);
});

test("claims a pairing and redeems it into an enrolled device", async (context) => {
  const subject = "google-oauth2|panel-user";
  let codeHash: Buffer | null = null;
  let redeemed = false;
  const pairing: PairingRecord = {
    id: "00000000-0000-4000-8000-000000000010",
    deviceName: "Test PC",
    platform: null,
    accountId: null,
    expiresAt: new Date(0),
  };
  const store: RelayStore = {
    accountIdForSubject: async (received) => {
      assert.equal(received, subject);
      return accountId;
    },
    enrollDevice: async (receivedAccountId, name, platform) => {
      assert.equal(receivedAccountId, accountId);
      assert.equal(name, "Test PC");
      assert.equal(platform, null);
      return { device: { ...device, name, platform }, token };
    },
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: unused,
    createPairing: async (_id, receivedHash, deviceName, platform, expiresAt) => {
      pairing.deviceName = deviceName;
      pairing.platform = platform;
      pairing.expiresAt = expiresAt;
      codeHash = receivedHash;
    },
    findPairing: async (receivedHash) =>
      codeHash && receivedHash.equals(codeHash) ? { ...pairing } : null,
    claimPairing: async (receivedHash, receivedAccountId) => {
      assert.equal(receivedAccountId, accountId);
      if (!codeHash || !receivedHash.equals(codeHash) || pairing.accountId) {
        return null;
      }
      pairing.accountId = receivedAccountId;
      return { ...pairing };
    },
    redeemPairing: async (receivedHash) => {
      if (
        !codeHash ||
        !receivedHash.equals(codeHash) ||
        !pairing.accountId ||
        redeemed
      ) {
        return null;
      }
      redeemed = true;
      return { ...pairing };
    },
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
  app.use(buildRoutes(config, store, new RouterState(), {
    authFactory: (_config, scope) => (request, _response, next) => {
      (request as AuthenticatedRequest).auth = {
        subject,
        scopes: new Set(scope ? [scope] : []),
        claims: {},
      };
      next();
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const authorization = "Bearer panel-token";

  const created = await fetch(`${origin}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test PC" }),
  });
  assert.equal(created.status, 201);
  const { code } = await created.json();

  const preview = await fetch(`${origin}/v1/pairings/${code}`, {
    headers: { authorization },
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    deviceName: "Test PC",
    platform: null,
    expiresAt: pairing.expiresAt.toISOString(),
    claimed: false,
  });

  const claimed = await fetch(`${origin}/v1/pairings/${code}/claim`, {
    method: "POST",
    headers: { authorization },
  });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), {
    deviceName: "Test PC",
    platform: null,
  });

  const previewAfter = await fetch(`${origin}/v1/pairings/${code}`, {
    headers: { authorization },
  });
  assert.equal(previewAfter.status, 200);
  assert.deepEqual(await previewAfter.json(), {
    deviceName: "Test PC",
    platform: null,
    expiresAt: pairing.expiresAt.toISOString(),
    claimed: true,
  });

  const doubleClaim = await fetch(`${origin}/v1/pairings/${code}/claim`, {
    method: "POST",
    headers: { authorization },
  });
  assert.equal(doubleClaim.status, 409);
  assert.deepEqual(await doubleClaim.json(), {
    error: "pairing_already_claimed",
  });

  const missingPreview = await fetch(`${origin}/v1/pairings/ABCD-EFGH`, {
    headers: { authorization },
  });
  assert.equal(missingPreview.status, 404);
  assert.deepEqual(await missingPreview.json(), { error: "pairing_not_found" });

  const redeemedResponse = await fetch(`${origin}/v1/pairings/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(redeemedResponse.status, 200);
  assert.deepEqual(await redeemedResponse.json(), {
    device: {
      id: deviceId,
      name: "Test PC",
      platform: null,
      lastSeenAt: null,
      revokedAt: null,
      activeWorkers: 0,
    },
    device_token: token,
  });

  const secondRedeem = await fetch(`${origin}/v1/pairings/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(secondRedeem.status, 404);
  assert.deepEqual(await secondRedeem.json(), { error: "pairing_not_found" });
});

test("retries device enrollment with a suffixed name after a conflict", async (context) => {
  const pairing: PairingRecord = {
    id: "00000000-0000-4000-8000-000000000011",
    deviceName: "Test PC",
    platform: "win32-x64",
    accountId,
    expiresAt: new Date(Date.now() + 600_000),
  };
  let enrollAttempts = 0;
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: async (receivedAccountId, name, platform) => {
      assert.equal(receivedAccountId, accountId);
      enrollAttempts += 1;
      if (enrollAttempts === 1) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      return { device: { ...device, name, platform }, token };
    },
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: unused,
    createPairing: unused,
    findPairing: async () => pairing,
    claimPairing: unused,
    redeemPairing: async () => pairing,
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
  app.use(buildRoutes(config, store, new RouterState()));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const redeemedResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/pairings/redeem`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "WXYZ-2345" }),
    },
  );

  assert.equal(redeemedResponse.status, 200);
  const body = await redeemedResponse.json();
  assert.equal(body.device.name, "Test PC-2");
  assert.equal(body.device_token, token);
  assert.equal(enrollAttempts, 2);
});
