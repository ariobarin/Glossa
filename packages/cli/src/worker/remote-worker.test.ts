import assert from "node:assert/strict";
import test from "node:test";
import { RemoteWorker, type RemoteWorkerStatus } from "./remote-worker.js";

test("reports retry, connection, and graceful disconnection", async () => {
  const controller = new AbortController();
  const statuses: RemoteWorkerStatus[] = [];
  const paths: string[] = [];
  let registrations = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/device/register") {
      registrations += 1;
      if (registrations === 1) throw new Error("relay unavailable");
      const body = JSON.parse(String(init?.body)) as { workerId: string };
      return Response.json({
        workerId: body.workerId,
        generation: "00000000-0000-4000-8000-000000000001",
      });
    }
    if (url.pathname === "/device/poll") {
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
    sleep: async () => {},
    onStatus: (status) => statuses.push(status),
  }).run();

  assert.deepEqual(statuses.map((status) => status.state), [
    "connecting",
    "retrying",
    "connected",
    "disconnected",
  ]);
  assert.deepEqual(paths, [
    "/device/register",
    "/device/register",
    "/device/poll",
    "/device/unregister",
  ]);
});

test("falls back to current registration when capabilities are unsupported", async () => {
  const controller = new AbortController();
  const registerBodies: Array<Record<string, unknown>> = [];
  const statuses: RemoteWorkerStatus[] = [];
  const generation = "00000000-0000-4000-8000-000000000001";

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      registerBodies.push(body);
      if (registerBodies.length === 1) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      return Response.json({ workerId: body.workerId, generation });
    }
    if (url.pathname === "/device/poll") {
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
    onStatus: (status) => statuses.push(status),
  }).run();

  assert.equal(registerBodies.length, 2);
  assert.deepEqual(registerBodies[0]?.capabilities, { commandProgress: true });
  assert.equal("capabilities" in registerBodies[1]!, false);
  assert.equal(
    statuses.find((status) => status.state === "connected")?.legacyRelay,
    false,
  );
});

test("falls back to the legacy single-worker protocol", async () => {
  const controller = new AbortController();
  const registerBodies: Array<Record<string, unknown>> = [];
  const statuses: RemoteWorkerStatus[] = [];
  const generation = "00000000-0000-4000-8000-000000000001";

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      registerBodies.push(body);
      if ("workerId" in body) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      return Response.json({ deviceId: "legacy-device", generation });
    }
    if (url.pathname === "/device/poll") {
      assert.deepEqual(body, { generation });
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
    onStatus: (status) => statuses.push(status),
  }).run();

  assert.equal(registerBodies.length, 3);
  assert.deepEqual(registerBodies[0]?.capabilities, { commandProgress: true });
  assert.equal("capabilities" in registerBodies[1]!, false);
  assert.deepEqual(registerBodies[2], {});
  assert.equal(
    statuses.find((status) => status.state === "connected")?.legacyRelay,
    true,
  );
});

test("falls back to device auth when worker unregister is rejected", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"b".repeat(43)}`;
  const unregisterAuthorizations: Array<string | null> = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
      });
    }
    if (url.pathname === "/device/poll") {
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      unregisterAuthorizations.push(authorization);
      return authorization?.startsWith("Worker ")
        ? Response.json({ error: "invalid_worker" }, { status: 401 })
        : new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
  }).run();

  assert.deepEqual(unregisterAuthorizations, [
    `Worker ${workerToken}`,
    "Device device-token",
  ]);
});

test("does not retry unregister after a network failure", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"b".repeat(43)}`;
  const unregisterAuthorizations: Array<string | null> = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
      });
    }
    if (url.pathname === "/device/poll") {
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      unregisterAuthorizations.push(authorization);
      throw new Error("relay unavailable");
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
  }).run();

  assert.deepEqual(unregisterAuthorizations, [`Worker ${workerToken}`]);
});

test("re-registers when an ephemeral worker credential is rejected", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerTokens = [
    `glw_${"b".repeat(43)}`,
    `glw_${"c".repeat(43)}`,
  ];
  const statuses: RemoteWorkerStatus[] = [];
  let registrations = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      assert.equal(authorization, "Device device-token");
      const workerToken = workerTokens[registrations]!;
      registrations += 1;
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
      });
    }
    if (url.pathname === "/device/poll") {
      assert.equal(authorization, `Worker ${workerTokens[registrations - 1]}`);
      if (registrations === 1) {
        return Response.json({ error: "invalid_worker" }, { status: 401 });
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/unregister") {
      assert.equal(authorization, `Worker ${workerTokens[1]}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
    sleep: async () => {},
    onStatus: (status) => statuses.push(status),
  }).run();

  assert.equal(registrations, 2);
  assert.deepEqual(statuses.map((status) => status.state), [
    "connecting",
    "connected",
    "retrying",
    "connected",
    "disconnected",
  ]);
});

test("uses a worker credential for current-protocol hot requests", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"b".repeat(43)}`;
  let workerId = "";
  let releaseHandler: (() => void) | undefined;
  const heartbeatSeen = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const paths: string[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      assert.equal(authorization, "Device device-token");
      workerId = String(body.workerId);
      return Response.json({ workerId, generation, workerToken });
    }
    assert.equal(authorization, `Worker ${workerToken}`);
    if (url.pathname === "/device/poll") {
      return Response.json({
        job: {
          type: "read_file",
          requestId: "00000000-0000-4000-8000-000000000002",
          path: "README.md",
        },
      });
    }
    if (url.pathname === "/device/heartbeat") {
      assert.deepEqual(body, { workerId, generation });
      releaseHandler?.();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/result") {
      controller.abort();
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/device/unregister") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await new RemoteWorker({
    origin: "https://relay.glossa.test",
    deviceToken: "device-token",
    worker: {
      async handle(job) {
        await heartbeatSeen;
        return { requestId: job.requestId, ok: true, value: { content: "ok" } };
      },
    },
    signal: controller.signal,
    fetcher,
    heartbeatMs: 1,
  }).run();

  assert.equal(paths.includes("/device/heartbeat"), true);
});
