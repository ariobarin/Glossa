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
    "Could not connect: TLS handshake failed Retrying in 2 seconds.",
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
    "Connection lost: TLS handshake failed Retrying in 2 seconds.",
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
    assert.deepEqual(events[index * 2 + 1], {
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
    { type: "activity", phase: "returned", job, ok: false },
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
