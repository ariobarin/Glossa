import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { MAX_TEXT_BYTES } from "@glossa/protocol";
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

test("accepts legacy and concurrent worker registration without charging valid traffic", async (context) => {
  const store: RelayStore = {
    accountIdForSubject: unused,
    enrollDevice: unused,
    listDevices: unused,
    renameDevice: unused,
    revokeDevice: unused,
    authenticateDevice: async (id) => id === deviceId ? device : null,
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

  const heartbeat = await fetch(`${origin}/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Device ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workerId, generation: current.generation }),
  });
  assert.equal(heartbeat.status, 204);
});
