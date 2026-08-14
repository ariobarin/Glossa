import assert from "node:assert/strict";
import test from "node:test";
import { pairDevice } from "./device-pairing.js";
import type { StoredDeviceCredential } from "./device-store.js";
import {
  PairingCodeExpiredError,
  type PairingRedemption,
  type RelayEndpoints,
} from "./relay-client.js";

const endpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const pairedDevice: StoredDeviceCredential = {
  relayOrigin: endpoints.relayOrigin,
  deviceId: "00000000-0000-4000-8000-000000000002",
  deviceName: "gpu-box",
  token: "gld_00000000-0000-4000-8000-000000000002_placeholder",
};

function grant(code: string, ttlMs = 600_000): { code: string; expiresAt: string } {
  return { code, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

test("pairs with a relay-issued code and stores nothing itself", async () => {
  const messages: string[] = [];
  const created: Array<{ name: string; platform: string }> = [];
  let polls = 0;
  const paired = await pairDevice(endpoints, undefined, {
    defaultDeviceName: () => "gpu-box",
    createPairing: async (_endpoints, name, platform) => {
      created.push({ name, platform });
      return grant("ABCD-EFGH");
    },
    redeemPairing: async (_endpoints, code): Promise<PairingRedemption> => {
      assert.equal(code, "ABCD-EFGH");
      polls += 1;
      if (polls === 1) return "pending";
      return {
        device: { id: pairedDevice.deviceId, name: pairedDevice.deviceName },
        token: pairedDevice.token,
      };
    },
    delay: async () => undefined,
    log: (message) => messages.push(message),
  });

  assert.deepEqual(paired, pairedDevice);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.name, "gpu-box");
  assert.match(created[0]!.platform, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.deepEqual(messages, [
    "This computer needs to be paired with Glossa.",
    "",
    "Pairing code: ABCD-EFGH (valid for 10 minutes)",
    "",
    "Enter it at https://mcp.glossa.test/panel",
    "Paired with Glossa as gpu-box.",
  ]);
});

test("shows a fresh code when the relay reports the code expired", async () => {
  const messages: string[] = [];
  const codes = ["ABCD-EFGH", "IJKL-MNOP"];
  const paired = await pairDevice(endpoints, undefined, {
    defaultDeviceName: () => "gpu-box",
    createPairing: async () => grant(codes.shift()!),
    redeemPairing: async (_endpoints, code): Promise<PairingRedemption> => {
      if (code === "ABCD-EFGH") {
        throw new PairingCodeExpiredError(
          "The pairing code expired. Glossa will show a fresh one.",
        );
      }
      return {
        device: { id: pairedDevice.deviceId, name: pairedDevice.deviceName },
        token: pairedDevice.token,
      };
    },
    delay: async () => undefined,
    log: (message) => messages.push(message),
  });

  assert.deepEqual(paired, pairedDevice);
  assert.ok(
    messages.includes("The pairing code expired. Glossa will show a fresh one."),
  );
  assert.equal(
    messages.filter((message) => message.startsWith("Pairing code: ")).length,
    2,
  );
  assert.ok(messages.includes("Pairing code: IJKL-MNOP (valid for 10 minutes)"));
});

test("times out after three unclaimed codes", async () => {
  const messages: string[] = [];
  let currentTime = Date.now();
  await assert.rejects(
    pairDevice(endpoints, undefined, {
      defaultDeviceName: () => "gpu-box",
      createPairing: async () => ({
        code: "ABCD-EFGH",
        expiresAt: new Date(currentTime + 1_000).toISOString(),
      }),
      redeemPairing: async () => "pending",
      delay: async () => {
        currentTime += 2_000;
      },
      now: () => currentTime,
      log: (message) => messages.push(message),
    }),
    /Pairing timed out\. Run Glossa again to retry\./,
  );
  assert.equal(
    messages.filter((message) => message.startsWith("Pairing code: ")).length,
    3,
  );
});

test("cancels pairing when the managed session aborts", async () => {
  const controller = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const pending = pairDevice(endpoints, controller.signal, {
    defaultDeviceName: () => "gpu-box",
    createPairing: async () => grant("ABCD-EFGH"),
    redeemPairing: async () => "pending",
    delay: async (_milliseconds, delaySignal) => {
      resolveStarted();
      await new Promise<void>((_resolve, reject) => {
        delaySignal?.addEventListener("abort", () => reject(delaySignal.reason), {
          once: true,
        });
      });
    },
    log: () => undefined,
  });

  await started;
  controller.abort();
  await assert.rejects(pending, /Pairing canceled/);
});
