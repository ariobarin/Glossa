import assert from "node:assert/strict";
import test from "node:test";
import type { StoredDeviceCredential } from "./device-store.js";
import { pairDevice } from "./device-pairing.js";
import type { DevicePairingChallenge, RelayEndpoints } from "./relay-client.js";

const endpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const challenge: DevicePairingChallenge = {
  pairingId: "00000000-0000-4000-8000-000000000001",
  userCode: "ABCDE-FGHJK",
  pairingSecret: "pairing-secret-not-a-real-credential-value",
  expiresAt: "2026-08-12T12:05:00.000Z",
  pollIntervalMs: 2_000,
};
const pairedDevice: StoredDeviceCredential = {
  relayOrigin: endpoints.relayOrigin,
  deviceId: "00000000-0000-4000-8000-000000000002",
  deviceName: "gpu-box",
  token: "gld_00000000-0000-4000-8000-000000000002_placeholder",
};

test("prints a ChatGPT pairing instruction and waits for approval", async () => {
  const messages: string[] = [];
  let completions = 0;
  const paired = await pairDevice(endpoints, undefined, {
    defaultDeviceName: () => "gpu-box",
    beginDevicePairing: async (_endpoints, name) => {
      assert.equal(name, "gpu-box");
      return challenge;
    },
    completeDevicePairing: async () => {
      completions += 1;
      return completions < 2 ? null : pairedDevice;
    },
    wait: async () => undefined,
    now: () => Date.parse("2026-08-12T12:00:00.000Z"),
    log: (message) => messages.push(message),
  });

  assert.equal(paired, pairedDevice);
  assert.equal(completions, 2);
  assert.ok(messages.includes("@Glossa pair ABCDE-FGHJK"));
  assert.ok(messages.includes("Paired with Glossa as gpu-box."));
});

test("cancels pairing when the managed session aborts", async () => {
  const controller = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const pending = pairDevice(endpoints, controller.signal, {
    beginDevicePairing: async () => challenge,
    wait: async (_milliseconds, signal) => {
      resolveStarted();
      return await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    now: () => Date.parse("2026-08-12T12:00:00.000Z"),
    log: () => undefined,
  });

  await started;
  controller.abort();
  await assert.rejects(pending, /Pairing canceled/);
});
