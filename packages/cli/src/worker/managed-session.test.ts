import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCredentials } from "../config-store.js";
import type { StoredDeviceCredential } from "../device-store.js";
import type { RelayEndpoints } from "../relay-client.js";
import {
  deviceForSession,
  localStatus,
  reenrollRejectedDevice,
  shouldRecoverRejectedDevice,
} from "./managed-session.js";
import { DeviceRejectedError } from "./remote-worker.js";

test("aborts device enrollment when the UI session stops", async () => {
  const controller = new AbortController();
  const endpoints = {
    relayOrigin: "https://relay.example",
    workerOrigin: "wss://worker.example",
  };
  const credentials = {
    issuer: "https://issuer.example",
    clientId: "client",
    audience: "relay",
    accessToken: "access",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    tokenType: "Bearer",
  };
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });

  const pending = deviceForSession(
    endpoints,
    {
      loadDeviceCredential: async () => null,
      loadCredentials: async () => ({ credentials, backend: "keyring" }),
      fetch: async (_input, init) => {
        assert.equal(init?.signal, controller.signal);
        fetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
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


const enrollmentEndpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const enrollmentCredentials: StoredCredentials = {
  issuer: "https://identity.glossa.test/",
  clientId: "client",
  audience: "https://mcp.glossa.test/",
  accessToken: "access",
  expiresAt: "2099-01-01T00:00:00.000Z",
  tokenType: "Bearer",
};
const enrollmentLoaded = { credentials: enrollmentCredentials, backend: "file" as const };
const enrollmentResult: StoredDeviceCredential = {
  relayOrigin: enrollmentEndpoints.relayOrigin,
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceName: "Laptop",
  token: "gld_laptop_token",
};

function enrollmentDependencies() {
  return {
    accessTokenSubject: () => "google-oauth2|account-1",
    loadDeviceCredential: async () => null,
    loadCredentials: async () => enrollmentLoaded,
    validCredentials: async (value: StoredCredentials) => value,
    accountOwnsDevice: async () => false,
    enrollDevice: async (_endpoints: RelayEndpoints, _credentials: StoredCredentials, name: string) => ({
      ...enrollmentResult,
      deviceName: name,
    }),
    saveDeviceCredential: async () => undefined,
    defaultDeviceName: () => "HOSTNAME",
  };
}

test("enrolls with the computer hostname", async () => {
  const result = await deviceForSession(
    enrollmentEndpoints,
    enrollmentDependencies(),
  );
  assert.equal(result.deviceName, "HOSTNAME");
});

test("reuses credentials already validated by session startup", async () => {
  let received: StoredCredentials | undefined;
  await deviceForSession(enrollmentEndpoints, {
    ...enrollmentDependencies(),
    credentials: enrollmentCredentials,
    loadCredentials: async () => {
      throw new Error("credentials should not be loaded again");
    },
    validCredentials: async () => {
      throw new Error("credentials should not be validated again");
    },
    enrollDevice: async (_endpoints, credentials, name) => {
      received = credentials;
      return { ...enrollmentResult, deviceName: name };
    },
  });
  assert.equal(received, enrollmentCredentials);
});

test("keeps the existing device without reenrolling", async () => {
  const stored: StoredDeviceCredential = {
    ...enrollmentResult,
    accountSubject: "google-oauth2|account-1",
    deviceName: "Old Desk",
  };
  let enrollCalled = false;
  const result = await deviceForSession(enrollmentEndpoints, {
    ...enrollmentDependencies(),
    credentials: enrollmentCredentials,
    loadDeviceCredential: async () => stored,
    loadCredentials: async () => {
      throw new Error("credentials should not be loaded for a stored device");
    },
    fetch: async () => {
      throw new Error("the relay should not be called for a stored device");
    },
    accountOwnsDevice: async () => {
      throw new Error("bound devices should not need an ownership request");
    },
    enrollDevice: async () => {
      enrollCalled = true;
      return enrollmentResult;
    },
  });
  assert.equal(enrollCalled, false);
  assert.equal(result.deviceName, "Old Desk");
});

test("verifies and binds a legacy stored device once", async () => {
  const stored: StoredDeviceCredential = {
    ...enrollmentResult,
    deviceName: "Legacy device",
  };
  let ownershipCalls = 0;
  let saved: StoredDeviceCredential | undefined;
  const result = await deviceForSession(enrollmentEndpoints, {
    ...enrollmentDependencies(),
    credentials: enrollmentCredentials,
    loadDeviceCredential: async () => stored,
    accountOwnsDevice: async () => {
      ownershipCalls += 1;
      return true;
    },
    saveDeviceCredential: async (device) => {
      saved = device;
    },
  });

  assert.equal(ownershipCalls, 1);
  assert.equal(result.accountSubject, "google-oauth2|account-1");
  assert.equal(saved, result);
});

test("re-enrolls instead of using a device from another account", async () => {
  let deleteCalls = 0;
  let ownershipCalls = 0;
  let enrollCalls = 0;
  const result = await deviceForSession(enrollmentEndpoints, {
    ...enrollmentDependencies(),
    credentials: enrollmentCredentials,
    loadDeviceCredential: async () => ({
      ...enrollmentResult,
      accountSubject: "google-oauth2|old-account",
    }),
    deleteDeviceCredential: async () => {
      deleteCalls += 1;
    },
    accountOwnsDevice: async () => {
      ownershipCalls += 1;
      return true;
    },
    enrollDevice: async () => {
      enrollCalls += 1;
      return enrollmentResult;
    },
  });

  assert.equal(deleteCalls, 1);
  assert.equal(ownershipCalls, 0);
  assert.equal(enrollCalls, 1);
  assert.equal(result.accountSubject, "google-oauth2|account-1");
});

test("re-enrolls once worker registration rejects the stored device", async () => {
  let stored: StoredDeviceCredential | null = {
    ...enrollmentResult,
    deviceName: "Revoked device",
  };
  let deleteCalls = 0;
  let enrollCalls = 0;
  const result = await reenrollRejectedDevice(enrollmentEndpoints, {
    ...enrollmentDependencies(),
    credentials: enrollmentCredentials,
    loadDeviceCredential: async () => stored,
    deleteDeviceCredential: async () => {
      deleteCalls += 1;
      stored = null;
    },
    enrollDevice: async () => {
      enrollCalls += 1;
      return enrollmentResult;
    },
  });

  assert.equal(deleteCalls, 1);
  assert.equal(enrollCalls, 1);
  assert.deepEqual(result, {
    ...enrollmentResult,
    accountSubject: "google-oauth2|account-1",
  });
});

test("only recovers a rejected device before its worker connects", () => {
  const rejection = new DeviceRejectedError();
  assert.equal(shouldRecoverRejectedDevice(rejection, false, false), true);
  assert.equal(shouldRecoverRejectedDevice(rejection, true, false), false);
  assert.equal(shouldRecoverRejectedDevice(rejection, false, true), false);
  assert.equal(
    shouldRecoverRejectedDevice(new Error("offline"), false, false),
    false,
  );
});

test("keeps retry details local and gives the current workspace retry timing", () => {
  const status = localStatus({
    state: "retrying",
    error: new Error("network diagnostic that must not reach the display"),
    retryInMs: 1_500,
  });
  assert.equal(status.state, "retrying");
  if (status.state !== "retrying") throw new Error("expected retry status");
  assert.equal(
    status.error.message,
    "The current workspace is reconnecting. Retrying in 2 seconds.",
  );
});
