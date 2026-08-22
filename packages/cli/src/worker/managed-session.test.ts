import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerJob } from "@glossa/protocol";
import type { StoredDeviceCredential } from "../device-store.js";
import type { RelayEndpoints } from "../relay-client.js";
import {
  accessProfileSummary,
  deviceForSession,
  statusMessage,
  visibleWorker,
} from "./managed-session.js";

test("aborts device pairing when the managed session stops", async () => {
  const controller = new AbortController();
  const endpoints = {
    relayOrigin: "https://relay.example",
    workerOrigin: "wss://worker.example",
  };
  let pairingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pairingStarted = resolve;
  });

  const pending = deviceForSession(
    endpoints,
    {
      loadDeviceCredential: async () => null,
      withDevicePairingLease: async <T>(action: () => Promise<T>) => await action(),
      pairDevice: async (_endpoints, signal) => {
        assert.equal(signal, controller.signal);
        pairingStarted();
        return await new Promise<StoredDeviceCredential>((_resolve, reject) => {
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    controller.signal,
  );

  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

const pairingEndpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const pairingResult: StoredDeviceCredential = {
  relayOrigin: pairingEndpoints.relayOrigin,
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceName: "Laptop",
  token: "gld_laptop_token",
};

function pairingDependencies() {
  return {
    loadDeviceCredential: async () => null,
    pairDevice: async () => pairingResult,
    saveDeviceCredential: async () => undefined,
    withDevicePairingLease: async <T>(action: () => Promise<T>) => await action(),
  };
}

test("pairs and saves a computer when no device credential exists", async () => {
  let saved: StoredDeviceCredential | undefined;
  const result = await deviceForSession(pairingEndpoints, {
    ...pairingDependencies(),
    saveDeviceCredential: async (device) => {
      saved = device;
    },
  });
  assert.equal(result, pairingResult);
  assert.equal(saved, pairingResult);
});

test("rechecks the device store after acquiring the pairing lease", async () => {
  let loads = 0;
  let pairCalls = 0;
  const result = await deviceForSession(pairingEndpoints, {
    ...pairingDependencies(),
    loadDeviceCredential: async () => {
      loads += 1;
      return loads === 1 ? null : pairingResult;
    },
    pairDevice: async () => {
      pairCalls += 1;
      return pairingResult;
    },
  });
  assert.equal(loads, 2);
  assert.equal(pairCalls, 0);
  assert.equal(result, pairingResult);
});

test("reuses an existing paired computer without user OAuth", async () => {
  const stored: StoredDeviceCredential = {
    ...pairingResult,
    accountSubject: "google-oauth2|legacy-binding",
    deviceName: "Old Desk",
  };
  let pairCalls = 0;
  let saveCalls = 0;
  const result = await deviceForSession(pairingEndpoints, {
    ...pairingDependencies(),
    loadDeviceCredential: async () => stored,
    pairDevice: async () => {
      pairCalls += 1;
      return pairingResult;
    },
    saveDeviceCredential: async () => {
      saveCalls += 1;
    },
  });
  assert.equal(pairCalls, 0);
  assert.equal(saveCalls, 0);
  assert.equal(result.deviceName, "Old Desk");
});

test("revokes a pairing at its old relay before pairing again", async () => {
  const calls: string[] = [];
  const oldRelay = "https://old-relay.glossa.test";
  const stored = {
    ...pairingResult,
    relayOrigin: oldRelay,
  };
  const result = await deviceForSession(pairingEndpoints, {
    ...pairingDependencies(),
    loadDeviceCredential: async () => stored,
    revokePairedDevice: async (endpoints, device) => {
      assert.equal(endpoints.relayOrigin, oldRelay);
      assert.equal(device, stored);
      calls.push("revoke");
    },
    deleteDeviceCredential: async () => {
      calls.push("delete");
    },
    pairDevice: async () => {
      calls.push("pair");
      return pairingResult;
    },
    saveDeviceCredential: async () => {
      calls.push("save");
    },
  });

  assert.deepEqual(calls, ["revoke", "delete", "pair", "save"]);
  assert.equal(result, pairingResult);
});

test("keeps retry diagnostics local and adds the current workspace timing", () => {
  assert.equal(
    statusMessage(
      {
        state: "retrying",
        error: new Error("TLS handshake failed"),
        retryInMs: 1_500,
      },
      false,
    ),
    "Could not connect: TLS handshake failed. Retrying in 2 seconds.",
  );
  assert.equal(
    statusMessage(
      {
        state: "retrying",
        error: new Error("TLS handshake failed"),
        retryInMs: 1_500,
      },
      true,
    ),
    "Connection lost: TLS handshake failed. Retrying in 2 seconds.",
  );
});

test("reports the actual job while working and when returned", async () => {
  const jobs: WorkerJob[] = [
    {
      type: "write_file",
      requestId: "00000000-0000-4000-8000-000000000001",
      path: "README.md",
      content: "updated",
    },
    {
      type: "edit_file",
      requestId: "00000000-0000-4000-8000-000000000002",
      path: "README.md",
      edits: [{ oldText: "old", newText: "new" }],
    },
    {
      type: "run_command",
      requestId: "00000000-0000-4000-8000-000000000003",
      argv: ["node", "--version"],
      timeoutMs: 1_000,
    },
    {
      type: "cancel_command",
      requestId: "00000000-0000-4000-8000-000000000004",
      commandId: "00000000-0000-4000-8000-000000000005",
    },
    {
      type: "read_file",
      requestId: "00000000-0000-4000-8000-000000000006",
      path: "README.md",
    },
  ];
  const events: unknown[] = [];
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    messages.push(String(message));
  };
  try {
    const worker = visibleWorker(
      {
        async handle(job) {
          if (job.type === "run_command") {
            return {
              requestId: job.requestId,
              ok: true,
              value: { status: "running" },
            };
          }
          return { requestId: job.requestId, ok: true };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    for (const job of jobs) await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  assert.equal(events.length, jobs.length * 2);
  assert.equal(messages.length, jobs.length);
  for (const [index, job] of jobs.entries()) {
    assert.deepEqual(events[index * 2], {
      type: "activity",
      phase: "started",
      job,
    });
    const returned = events[index * 2 + 1] as { output?: unknown };
    assert.deepEqual(
      returned.output,
      job.type === "run_command"
        ? { kind: "running", preview: "Command started and is still running." }
        : { kind: "success", preview: "Completed successfully." },
    );
    const { output: _output, ...returnedWithoutOutput } = returned;
    assert.deepEqual(returnedWithoutOutput, {
      type: "activity",
      phase: "returned",
      job,
      ok: true,
    });
  }
  assert.deepEqual(
    messages.map((message) => message.replace(/ \(.+\)\.$/, "")),
    [
      "write_file completed",
      "edit_file completed",
      "run_command started",
      "cancel_command completed",
      "read_file completed",
    ],
  );
});

test("Activity output previews reflect structured tool results", async () => {
  const jobs: WorkerJob[] = [
    {
      type: "read_file",
      requestId: "00000000-0000-4000-8000-000000000031",
      path: "src/example.ts",
    },
    {
      type: "search_text",
      requestId: "00000000-0000-4000-8000-000000000032",
      query: "activity",
      path: "src",
      timeoutMs: 5_000,
    },
    {
      type: "edit_file",
      requestId: "00000000-0000-4000-8000-000000000033",
      path: "src/example.ts",
      edits: [{ oldText: "old", newText: "new" }],
    },
  ];
  const events: unknown[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle(job) {
          if (job.type === "read_file") {
            return {
              requestId: job.requestId,
              ok: true,
              value: {
                content: `FILE-HEAD${String.fromCharCode(27)}[2J\n${"x".repeat(900)}\nFILE-TAIL`,
                sha256: "read-sha",
                bytes: 920,
              },
            };
          }
          if (job.type === "search_text") {
            return {
              requestId: job.requestId,
              ok: true,
              value: {
                matches: [{
                  path: "src/example.ts",
                  line: 12,
                  column: 4,
                  text: "const activity = true;",
                  lineTruncated: false,
                }],
                truncated: false,
                scannedFiles: 1,
                scannedBytes: 42,
                skippedFiles: 0,
                skippedLinks: 0,
              },
            };
          }
          return {
            requestId: job.requestId,
            ok: true,
            value: {
              sha256: "edit-sha",
              bytes: 10,
              replacements: 1,
              diff: "--- a/src/example.ts\n+++ b/src/example.ts\n-old\n+new",
              diffTruncated: false,
            },
          };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    for (const job of jobs) await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  const returned = events.filter((event) =>
    typeof event === "object" && event !== null && "phase" in event && event.phase === "returned"
  ) as Array<{ output?: { preview?: string; truncated?: boolean } }>;
  assert.match(returned[0]?.output?.preview ?? "", /FILE-HEAD\\u001b\[2J/);
  assert.match(returned[0]?.output?.preview ?? "", /output truncated/);
  assert.match(returned[0]?.output?.preview ?? "", /FILE-TAIL/);
  assert.equal(returned[0]?.output?.truncated, true);
  assert.equal(returned[1]?.output?.preview, "src/example.ts:12:4  const activity = true;");
  assert.match(returned[2]?.output?.preview ?? "", /--- a\/src\/example\.ts/);
  assert.match(returned[2]?.output?.preview ?? "", /\+new/);
});

test("Activity shows elapsed command progress only when output is quiet", async () => {
  const job: WorkerJob = {
    type: "get_command",
    requestId: "00000000-0000-4000-8000-000000000034",
    commandId: "00000000-0000-4000-8000-000000000035",
  };
  const events: unknown[] = [];
  let calls = 0;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle(requestedJob) {
          calls += 1;
          return {
            requestId: requestedJob.requestId,
            ok: true,
            value: calls === 1
              ? { status: "running", elapsedMs: 42_999 }
              : calls === 2
                ? { status: "running", elapsedMs: 42_999, stdout: "working" }
                : { status: "running", elapsedMs: 42_999, stderr: "waiting" },
          };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    await worker.handle(job);
    await worker.handle(job);
    await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  const returned = events.filter((event) =>
    typeof event === "object" && event !== null && "phase" in event && event.phase === "returned"
  ) as Array<{ output?: { preview?: string } }>;
  assert.equal(
    returned[0]?.output?.preview,
    "Command is still running after 42s with no captured output.",
  );
  assert.equal(returned[1]?.output?.preview, "working");
  assert.equal(returned[2]?.output?.preview, "waiting");
});

test("Activity retains valid sequence metadata only for get_command", async () => {
  const jobs: WorkerJob[] = [
    {
      type: "get_command",
      requestId: "00000000-0000-4000-8000-000000000041",
      commandId: "00000000-0000-4000-8000-000000000042",
    },
    {
      type: "get_command",
      requestId: "00000000-0000-4000-8000-000000000043",
      commandId: "00000000-0000-4000-8000-000000000042",
    },
    {
      type: "get_command",
      requestId: "00000000-0000-4000-8000-000000000044",
      commandId: "00000000-0000-4000-8000-000000000042",
    },
    {
      type: "run_command",
      requestId: "00000000-0000-4000-8000-000000000045",
      argv: ["node", "script.js"],
      timeoutMs: 30_000,
    },
  ];
  const sequences = [4, -1, 1.5, 8];
  const events: unknown[] = [];
  let calls = 0;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle(requestedJob) {
          const sequence = sequences[calls++]!;
          return {
            requestId: requestedJob.requestId,
            ok: true,
            value: { status: "running", sequence },
          };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    for (const job of jobs) await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  const returned = events.filter((event) =>
    typeof event === "object" && event !== null && "phase" in event && event.phase === "returned"
  ) as Array<{ output?: { sequence?: number } }>;
  assert.deepEqual(
    returned.map((event) => event.output?.sequence),
    [4, undefined, undefined, undefined],
  );
});

test("bounds command output previews and marks truncation", async () => {
  const job: WorkerJob = {
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000009",
    argv: ["npm", "test"],
    timeoutMs: 30_000,
  };
  const events: unknown[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle(requestedJob) {
          return {
            requestId: requestedJob.requestId,
            ok: true,
            value: {
              status: "failed",
              exitCode: 1,
              stderr: `failure-start\n${"x".repeat(2_500)}\nfailure-end`,
              stderrTruncated: true,
            },
          };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  const returned = events[1] as {
    output?: { kind: string; preview?: string; truncated?: boolean };
  };
  assert.equal(returned.output?.kind, "error");
  assert.equal(returned.output?.truncated, true);
  assert.match(returned.output?.preview ?? "", /failure-start/);
  assert.match(returned.output?.preview ?? "", /output truncated/);
  assert.match(returned.output?.preview ?? "", /failure-end/);
  assert.ok(Array.from(returned.output?.preview ?? "").length <= 512);
});

test("returns a failed activity when its worker throws", async () => {
  const job: WorkerJob = {
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000007",
    path: "README.md",
  };
  const events: unknown[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle() {
          throw new Error("read failed");
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    await assert.rejects(worker.handle(job), /read failed/);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(events, [
    { type: "activity", phase: "started", job },
    {
      type: "activity",
      phase: "returned",
      job,
      ok: false,
      output: { kind: "error", preview: "read failed" },
    },
  ]);
});

test("describes access profiles", () => {
  assert.match(accessProfileSummary("read-only"), /cannot modify.*run commands/i);
  assert.match(accessProfileSummary("workspace"), /modify files.*commands are disabled/i);
  assert.match(
    accessProfileSummary("system"),
    /full environment.*permissions.*credentials.*network access/i,
  );
});

test("redacts restricted inputs from local activity events", async () => {
  const key = "sk-proj-" + "A".repeat(32);
  const job: WorkerJob = {
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000008",
    argv: ["node", "-e", `process.stdout.write(${JSON.stringify(key)})`],
    stdin: `OPENAI_API_KEY=${key}`,
    timeoutMs: 1_000,
  };
  const events: unknown[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const worker = visibleWorker(
      {
        async handle(requestedJob) {
          return {
            requestId: requestedJob.requestId,
            ok: false,
            error: {
              code: "restricted_data_blocked",
              message: "blocked",
            },
          };
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    await worker.handle(job);
  } finally {
    console.error = originalError;
  }

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, new RegExp(key));
  assert.doesNotMatch(serialized, /OPENAI_API_KEY/);
  assert.match(serialized, /restricted input blocked/);
});
