import assert from "node:assert/strict";
import test from "node:test";
import type { StoredDeviceCredential } from "./device-store.js";
import { unpairComputer } from "./unpair.js";

const device: StoredDeviceCredential = {
  relayOrigin: "https://mcp.glossa.test",
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceName: "gpu-box",
  token: "gld_00000000-0000-4000-8000-000000000001_placeholder",
};

test("revokes the paired device before deleting the local credential", async () => {
  const calls: string[] = [];
  await unpairComputer({
    loadDeviceCredential: async () => device,
    revokePairedDevice: async (endpoints, received) => {
      assert.equal(endpoints.relayOrigin, device.relayOrigin);
      assert.equal(received, device);
      calls.push("revoke");
    },
    deleteDeviceCredential: async () => {
      calls.push("delete");
    },
    log: (message) => calls.push(message),
  });

  assert.deepEqual(calls, [
    "revoke",
    "delete",
    "Unpaired this computer from Glossa.",
  ]);
});

test("reports an already unpaired computer without contacting the relay", async () => {
  const messages: string[] = [];
  await unpairComputer({
    loadDeviceCredential: async () => null,
    revokePairedDevice: async () => {
      throw new Error("relay should not be called");
    },
    deleteDeviceCredential: async () => {
      throw new Error("nothing should be deleted");
    },
    log: (message) => messages.push(message),
  });
  assert.deepEqual(messages, ["This computer is not paired with Glossa."]);
});

test("revokes a credential at its stored relay before deleting it", async () => {
  const calls: string[] = [];
  const oldRelay = "https://old-relay.glossa.test";
  await unpairComputer({
    loadDeviceCredential: async () => ({
      ...device,
      relayOrigin: oldRelay,
    }),
    revokePairedDevice: async (endpoints) => {
      assert.equal(endpoints.relayOrigin, oldRelay);
      calls.push("revoke");
    },
    deleteDeviceCredential: async () => {
      calls.push("delete");
    },
    log: () => undefined,
  });
  assert.deepEqual(calls, ["revoke", "delete"]);
});
