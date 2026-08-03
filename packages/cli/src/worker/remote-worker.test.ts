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

test("registers stable workspace identity before polling", async () => {
  const controller = new AbortController();
  let registration: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/device/register") {
      registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        workerId: registration.workerId,
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
    workspaceId: "00000000-0000-4000-8000-000000000002",
    rootPath: "C:\\code\\glossa",
    workspaceLabel: "glossa",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
  }).run();

  assert.equal(
    registration?.workspaceId,
    "00000000-0000-4000-8000-000000000002",
  );
  assert.equal(registration?.rootPath, "C:\\code\\glossa");
  assert.equal(registration?.workspaceLabel, "glossa");
});

test("falls back without a label when the relay does not accept labels", async () => {
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
      return Response.json({
        workerId: body.workerId,
        generation,
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
        },
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
    workspaceLabel: "frontend",
    worker: { handle: async () => ({ requestId: "unused", ok: true }) },
    signal: controller.signal,
    fetcher,
    onStatus: (status) => statuses.push(status),
  }).run();

  assert.equal(registerBodies.length, 2);
  assert.equal(registerBodies[0]?.workspaceLabel, "frontend");
  assert.equal("workspaceLabel" in registerBodies[1]!, false);
  assert.deepEqual(registerBodies[1]?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
  });
  const connected = statuses.find((status) => status.state === "connected");
  assert.equal(connected?.state, "connected");
  if (connected?.state === "connected") {
    assert.equal(connected.workspaceLabelAccepted, false);
  }
});

test("falls back when structured and concurrent capabilities are unsupported", async () => {
  const controller = new AbortController();
  const registerBodies: Array<Record<string, unknown>> = [];
  const statuses: RemoteWorkerStatus[] = [];
  const generation = "00000000-0000-4000-8000-000000000001";

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      registerBodies.push(body);
      if (registerBodies.length <= 2) {
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

  assert.equal(registerBodies.length, 3);
  assert.deepEqual(registerBodies[0]?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
  });
  assert.deepEqual(registerBodies[1]?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
  });
  assert.deepEqual(registerBodies[2]?.capabilities, { commandProgress: true });
  assert.equal(
    statuses.find((status) => status.state === "connected")?.legacyRelay,
    false,
  );
});

test("keeps structured job types out of concurrency-only relay polls", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const registerBodies: Array<Record<string, unknown>> = [];
  let pollBody: Record<string, unknown> | undefined;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      registerBodies.push(body);
      const capabilities = body.capabilities as Record<string, unknown> | undefined;
      if (capabilities?.structuredReads === true) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      return Response.json({
        workerId: body.workerId,
        generation,
        capabilities: { commandProgress: true, concurrentJobs: true },
      });
    }
    if (url.pathname === "/device/poll") {
      pollBody = body;
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
  }).run();

  assert.equal(registerBodies.length, 2);
  const accepted = pollBody?.acceptedTypes as string[];
  assert.equal(accepted.includes("read_file"), true);
  assert.equal(accepted.includes("list_files"), false);
  assert.equal(accepted.includes("search_text"), false);
  assert.equal(accepted.includes("read_file_range"), false);
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

  assert.equal(registerBodies.length, 5);
  assert.deepEqual(registerBodies[0]?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
  });
  assert.deepEqual(registerBodies[1]?.capabilities, {
    commandProgress: true,
    concurrentJobs: true,
  });
  assert.deepEqual(registerBodies[2]?.capabilities, { commandProgress: true });
  assert.equal("capabilities" in registerBodies[3]!, false);
  assert.deepEqual(registerBodies[4], {});
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

test("handles cancellation while a command status wait is still running", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"d".repeat(43)}`;
  const getRequestId = "00000000-0000-4000-8000-000000000020";
  const cancelRequestId = "00000000-0000-4000-8000-000000000021";
  const commandId = "00000000-0000-4000-8000-000000000022";
  const queuedJobs = [
    {
      type: "get_command",
      requestId: getRequestId,
      commandId,
      waitMs: 15_000,
    },
    {
      type: "cancel_command",
      requestId: cancelRequestId,
      commandId,
    },
  ] as const;
  const pollBodies: Array<Record<string, unknown>> = [];
  const completed: string[] = [];
  let getStarted = false;
  let cancelHandled = false;
  let releaseGet!: () => void;
  const getRelease = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
        },
      });
    }
    if (url.pathname === "/device/poll") {
      pollBodies.push(body);
      const accepted = body.acceptedTypes as string[];
      const next = queuedJobs.find((job) => accepted.includes(job.type));
      if (next) {
        const index = queuedJobs.indexOf(next);
        (queuedJobs as unknown as Array<unknown>).splice(index, 1);
        return Response.json({ job: next });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/result") {
      const result = body.result as { requestId: string };
      completed.push(result.requestId);
      if (completed.length === 2) controller.abort();
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/device/heartbeat") {
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
    signal: controller.signal,
    fetcher,
    worker: {
      async handle(job) {
        if (job.type === "get_command") {
          getStarted = true;
          await getRelease;
          return {
            requestId: job.requestId,
            ok: true,
            value: { commandId, status: "canceled" },
          };
        }
        if (job.type === "cancel_command") {
          assert.equal(getStarted, true);
          cancelHandled = true;
          releaseGet();
          return {
            requestId: job.requestId,
            ok: true,
            value: { commandId, status: "canceled" },
          };
        }
        throw new Error(`Unexpected job: ${job.type}`);
      },
    },
  }).run();

  assert.equal(cancelHandled, true);
  assert.equal(completed.includes(getRequestId), true);
  assert.equal(completed.includes(cancelRequestId), true);
  assert.equal(pollBodies[0]?.waitMs, undefined);
  assert.equal(pollBodies[1]?.waitMs, undefined);
  assert.deepEqual(pollBodies[0]?.acceptedTypes, [
    "get_command",
    "cancel_command",
    "read_file",
    "list_files",
    "search_text",
    "read_file_range",
    "write_file",
    "edit_file",
    "run_command",
  ]);
  assert.equal(
    (pollBodies[1]?.acceptedTypes as string[]).includes("get_command"),
    false,
  );
  assert.equal(
    (pollBodies[1]?.acceptedTypes as string[]).includes("cancel_command"),
    true,
  );
});

test("keeps file mutation jobs serialized while other lanes stay available", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"e".repeat(43)}`;
  const writeRequestId = "00000000-0000-4000-8000-000000000030";
  let polls = 0;
  let releaseWrite!: () => void;
  const writeRelease = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
        },
      });
    }
    if (url.pathname === "/device/poll") {
      polls += 1;
      const accepted = body.acceptedTypes as string[];
      if (polls === 1) {
        assert.equal(body.waitMs, undefined);
        assert.equal(accepted.includes("write_file"), true);
        return Response.json({
          job: {
            type: "write_file",
            requestId: writeRequestId,
            path: "README.md",
            content: "updated",
          },
        });
      }
      assert.equal(body.waitMs, undefined);
      assert.equal(accepted.includes("write_file"), false);
      assert.equal(accepted.includes("edit_file"), false);
      assert.equal(accepted.includes("run_command"), false);
      assert.equal(accepted.includes("cancel_command"), true);
      assert.equal(accepted.includes("read_file"), true);
      releaseWrite();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/result") {
      controller.abort();
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/device/heartbeat") {
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
    signal: controller.signal,
    fetcher,
    worker: {
      async handle(job) {
        assert.equal(job.type, "write_file");
        await writeRelease;
        return { requestId: job.requestId, ok: true, value: { bytes: 7 } };
      },
    },
  }).run();

  assert.ok(polls >= 2);
});

test("refreshes a stale capacity poll as soon as a mutation lane becomes free", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"f".repeat(43)}`;
  const requestIds = [
    "00000000-0000-4000-8000-000000000040",
    "00000000-0000-4000-8000-000000000041",
  ];
  const pollBodies: Array<Record<string, unknown>> = [];
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let resolveStalePoll!: (response: Response) => void;
  const stalePoll = new Promise<Response>((resolve) => {
    resolveStalePoll = resolve;
  });
  let completed = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
        },
      });
    }
    if (url.pathname === "/device/poll") {
      pollBodies.push(body);
      const pollIndex = pollBodies.length - 1;
      if (pollIndex === 0) {
        return Response.json({
          job: {
            type: "write_file",
            requestId: requestIds[0],
            path: "README.md",
            content: "first",
          },
        });
      }
      if (pollIndex === 1) {
        const accepted = body.acceptedTypes as string[];
        assert.equal(accepted.includes("write_file"), false);
        releaseFirst();
        return await stalePoll;
      }
      if (pollIndex === 2) {
        assert.equal(body.waitMs, 1);
        assert.deepEqual(body.acceptedTypes, [
          "write_file",
          "edit_file",
          "run_command",
        ]);
        return Response.json({
          job: {
            type: "write_file",
            requestId: requestIds[1],
            path: "README.md",
            content: "second",
          },
        });
      }
      throw new Error(`Unexpected poll: ${pollIndex}`);
    }
    if (url.pathname === "/device/result") {
      completed += 1;
      if (completed === 2) {
        resolveStalePoll(new Response(null, { status: 204 }));
        controller.abort();
      }
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/device/heartbeat") {
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
    signal: controller.signal,
    fetcher,
    worker: {
      async handle(job) {
        assert.equal(job.type, "write_file");
        if (job.requestId === requestIds[0]) await firstRelease;
        return { requestId: job.requestId, ok: true, value: { bytes: 6 } };
      },
    },
  }).run();

  assert.equal(completed, 2);
  assert.equal(pollBodies.length, 3);
});

test("does not refresh capacity after an in-flight result fails", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const workerToken = `glw_${"g".repeat(43)}`;
  const requestId = "00000000-0000-4000-8000-000000000050";
  let polls = 0;
  let handled = 0;
  let releaseWrite!: () => void;
  const writeRelease = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const stalePoll = new Promise<Response>(() => {});

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({
        workerId: body.workerId,
        generation,
        workerToken,
        capabilities: {
          commandProgress: true,
          concurrentJobs: true,
          structuredReads: true,
        },
      });
    }
    if (url.pathname === "/device/poll") {
      polls += 1;
      if (polls === 1) {
        return Response.json({
          job: {
            type: "write_file",
            requestId,
            path: "README.md",
            content: "updated",
          },
        });
      }
      assert.equal(polls, 2);
      releaseWrite();
      return await stalePoll;
    }
    if (url.pathname === "/device/result") {
      return Response.json({ error: "relay_failure" }, { status: 500 });
    }
    if (url.pathname === "/device/heartbeat") {
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
    signal: controller.signal,
    fetcher,
    worker: {
      async handle(job) {
        handled += 1;
        await writeRelease;
        return { requestId: job.requestId, ok: true, value: { bytes: 7 } };
      },
    },
    onStatus(status) {
      if (status.state === "retrying") controller.abort();
    },
  }).run();

  assert.equal(handled, 1);
  assert.equal(polls, 2);
});

test("accepts a discarded late result without reconnecting", async () => {
  const controller = new AbortController();
  const generation = "00000000-0000-4000-8000-000000000001";
  const requestId = "00000000-0000-4000-8000-000000000002";
  let polls = 0;
  let handled = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/device/register") {
      return Response.json({ workerId: body.workerId, generation });
    }
    if (url.pathname === "/device/poll") {
      polls += 1;
      if (polls === 1) {
        return Response.json({
          job: { type: "read_file", requestId, path: "README.md" },
        });
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/device/result") {
      return Response.json({ accepted: false }, { status: 202 });
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
        handled += 1;
        return { requestId: job.requestId, ok: true, value: {} };
      },
    },
    signal: controller.signal,
    fetcher,
  }).run();

  assert.equal(handled, 1);
  assert.equal(polls, 2);
});
