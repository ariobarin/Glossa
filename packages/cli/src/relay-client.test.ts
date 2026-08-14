import assert from "node:assert/strict";
import test from "node:test";
import {
  enrollDevice,
  listDevices,
  revokeDevice,
  revokePairedDevice,
} from "./relay-client.js";

const endpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const pairingAuthorization = "Bearer access";
const deviceAuthorization = "Device paired-device-token";
const device = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test PC",
  platform: "win32-x64",
  lastSeenAt: "2026-07-20T00:00:00.000Z",
  revokedAt: null,
  activeWorkers: 2,
};

test("revokes a paired computer with its device credential", async () => {
  await revokePairedDevice(
    endpoints,
    {
      relayOrigin: endpoints.relayOrigin,
      deviceId: device.id,
      deviceName: device.name,
      token: "paired-device-token",
    },
    async (input, init) => {
      assert.equal(input, "https://mcp.glossa.test/device");
      assert.equal(init?.method, "DELETE");
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        deviceAuthorization,
      );
      return new Response(null, { status: 204 });
    },
  );
});

test("enrolls a device with temporary browser authorization", async () => {
  const enrolled = await enrollDevice(endpoints, pairingAuthorization, "Test PC", async (input, init) => {
    assert.equal(input, "https://mcp.glossa.test/v1/devices/enroll");
    assert.equal(init?.method, "POST");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      pairingAuthorization,
    );
    return Response.json({
      device: { id: device.id, name: device.name },
      device_token: "paired-device-token",
    }, { status: 201 });
  });

  assert.deepEqual(enrolled, {
    relayOrigin: endpoints.relayOrigin,
    deviceId: device.id,
    deviceName: device.name,
    token: "paired-device-token",
  });
});

test("lists devices with the device credential", async () => {
  const devices = await listDevices(endpoints, deviceAuthorization, async (input, init) => {
    assert.equal(input, "https://mcp.glossa.test/v1/devices");
    assert.equal((init?.headers as Record<string, string>).authorization, deviceAuthorization);
    return Response.json({ devices: [device] });
  });
  assert.deepEqual(devices, [device]);
});

test("revokes devices through the management API", async () => {
  await revokeDevice(endpoints, deviceAuthorization, device.id, async (input, init) => {
    assert.equal(input, `https://mcp.glossa.test/v1/devices/${device.id}`);
    assert.equal(init?.method, "DELETE");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      deviceAuthorization,
    );
    return new Response(null, { status: 204 });
  });
});

test("rejects incomplete status responses", async () => {
  await assert.rejects(
    listDevices(endpoints, deviceAuthorization, async () => Response.json({
      devices: [{ id: device.id, name: device.name, activeWorkers: 1 }],
    })),
    /invalid device list response/,
  );
});

test("accepts an older relay without inventing worker counts", async () => {
  const devices = await listDevices(endpoints, deviceAuthorization, async () => Response.json({
    devices: [{
      id: device.id,
      name: device.name,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    }],
  }));
  assert.equal(devices[0]?.activeWorkers, null);
});
