import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
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

test("removes a local credential when its relay is unavailable", async () => {
  const calls: string[] = [];
  await unpairComputer({
    loadDeviceCredential: async () => device,
    revokePairedDevice: async () => {
      calls.push("revoke");
      throw new Error("fetch failed");
    },
    deleteDeviceCredential: async () => {
      calls.push("delete");
    },
    log: (message) => calls.push(message),
  });

  assert.deepEqual(calls, [
    "revoke",
    "delete",
    `Removed this computer's local Glossa pairing, but could not confirm revocation at ${device.relayOrigin}: fetch failed. Revoke it from that relay's device panel if it becomes available.`,
  ]);
});

for (const status of [429, 503, null]) {
  test(`unpairs locally after a real HTTP ${status ?? "stall"}`, { timeout: 15_000 }, async (context) => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      assert.equal(request.method, "DELETE");
      assert.equal(request.url, "/device");
      request.resume();
      if (status !== null) response.writeHead(status).end("{}");
    });
    context.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let removed = false;
    const messages: string[] = [];
    const started = performance.now();
    await unpairComputer({
      loadDeviceCredential: async () => ({ ...device, relayOrigin: `http://127.0.0.1:${address.port}` }),
      deleteDeviceCredential: async () => { removed = true; },
      log: (message) => messages.push(message),
    });
    assert.equal(requests, 1);
    assert.equal(removed, true);
    assert.ok(performance.now() - started < 12_000, "revocation exceeded its deadline");
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /could not confirm revocation/);
  });
}

test("does not claim local removal when deleting the credential fails", async () => {
  const messages: string[] = [];
  await assert.rejects(unpairComputer({
    loadDeviceCredential: async () => device,
    revokePairedDevice: async () => { throw new Error("relay unavailable"); },
    deleteDeviceCredential: async () => { throw new Error("local deletion failed"); },
    log: (message) => messages.push(message),
  }), /local deletion failed/);
  assert.deepEqual(messages, []);
});
