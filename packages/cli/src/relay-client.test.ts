import assert from "node:assert/strict";
import test from "node:test";
import { NetworkRequestError } from "./network-error.js";
import {
  createPairing,
  enrollDevice,
  listDevices,
  PairingCodeExpiredError,
  redeemPairing,
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

test("creates a pairing code for this computer", async () => {
  const grant = await createPairing(endpoints, "Test PC", "win32-x64", async (input, init) => {
    assert.equal(input, "https://mcp.glossa.test/v1/pairings");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(init?.body as string), {
      name: "Test PC",
      platform: "win32-x64",
    });
    return Response.json({
      code: "ABCD-EFGH",
      expiresAt: "2026-08-14T17:30:00.000Z",
    }, { status: 201 });
  });

  assert.deepEqual(grant, { code: "ABCD-EFGH", expiresAt: "2026-08-14T17:30:00.000Z" });
});

test("redeems a claimed pairing code", async () => {
  const redeemed = await redeemPairing(endpoints, "ABCD-EFGH", async (input, init) => {
    assert.equal(input, "https://mcp.glossa.test/v1/pairings/redeem");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(init?.body as string), { code: "ABCD-EFGH" });
    return Response.json({
      device: { id: device.id, name: device.name },
      device_token: "paired-device-token",
    });
  });

  assert.deepEqual(redeemed, {
    device: { id: device.id, name: device.name },
    token: "paired-device-token",
  });
});

test("reports an unclaimed pairing code as pending", async () => {
  const redeemed = await redeemPairing(endpoints, "ABCD-EFGH", async () =>
    Response.json({ status: "pending" }, { status: 202 }));
  assert.equal(redeemed, "pending");
});

test("rejects an expired pairing code", async () => {
  await assert.rejects(
    redeemPairing(endpoints, "ABCD-EFGH", async () =>
      Response.json({ error: "pairing_not_found" }, { status: 404 })),
    (error: unknown) => {
      assert.ok(error instanceof PairingCodeExpiredError);
      assert.match(error.message, /pairing code expired/);
      return true;
    },
  );
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

test("normalizes rejected relay fetches before they reach the UI", async () => {
  const cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:39100"),
    { code: "ECONNREFUSED" },
  );
  await assert.rejects(
    listDevices(endpoints, deviceAuthorization, async () => {
      throw new TypeError("fetch failed", { cause });
    }),
    (error: unknown) => {
      assert.ok(error instanceof NetworkRequestError);
      assert.equal(error.code, "ECONNREFUSED");
      assert.equal(
        error.message,
        "Could not connect to the Glossa relay; the connection was refused.",
      );
      return true;
    },
  );
});
