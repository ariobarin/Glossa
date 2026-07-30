import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCredentials } from "./config-store.js";
import type { RelayDevice, RelayEndpoints } from "./relay-client.js";
import { WorkspaceStatusService } from "./status-service.js";

const credentials: StoredCredentials = {
  issuer: "https://identity.glossa.test/",
  clientId: "client",
  audience: "https://mcp.glossa.test/",
  accessToken: "access",
  expiresAt: "2099-01-01T00:00:00.000Z",
  tokenType: "Bearer",
};

const endpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://worker.glossa.test",
};

const devices: RelayDevice[] = [{
  id: "device-1",
  name: "Laptop",
  platform: "win32-x64",
  lastSeenAt: "2026-07-23T12:00:00.000Z",
  revokedAt: null,
  activeWorkers: 1,
}];

test("loads profile and devices in parallel", async () => {
  let profileStarted = false;
  let devicesStarted = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new WorkspaceStatusService(credentials, endpoints, {
    validCredentials: async (value) => value,
    loadUserProfile: async (value) => {
      profileStarted = true;
      await blocked;
      return {
        credentials: value,
        profile: { sub: "account-1", email: "dev@example.com" },
      };
    },
    listDevices: async () => {
      devicesStarted = true;
      await blocked;
      return devices;
    },
  });

  const pending = service.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(profileStarted, true);
  assert.equal(devicesStarted, true);
  release();

  const status = await pending;
  assert.equal(status.account, "dev@example.com");
  assert.equal(status.activeWorkers, 1);
});

test("keeps status useful when the account profile is unavailable", async () => {
  const service = new WorkspaceStatusService(credentials, endpoints, {
    validCredentials: async (value) => value,
    loadUserProfile: async () => {
      throw new Error("profile unavailable");
    },
    listDevices: async () => devices,
  });

  const status = await service.refresh();
  assert.equal(status.account, "Account unavailable");
  assert.equal(status.relay, endpoints.relayOrigin);
  assert.equal(status.activeWorkers, 1);
});

test("reports unavailable active worker counts", async () => {
  const service = new WorkspaceStatusService(credentials, endpoints, {
    validCredentials: async (value) => value,
    loadUserProfile: async (value) => {
      return {
        credentials: value,
        profile: { sub: "account-1", email: "dev@example.com" },
      };
    },
    listDevices: async () => devices.map((device) => ({
      ...device,
      activeWorkers: null,
    })),
  });

  const status = await service.refresh();
  assert.equal(status.account, "dev@example.com");
  assert.equal(status.activeWorkers, null);
});

test("omits revoked devices from status and workspace counts", async () => {
  const service = new WorkspaceStatusService(credentials, endpoints, {
    validCredentials: async (value) => value,
    loadUserProfile: async (value) => ({
      credentials: value,
      profile: { sub: "account-1", email: "dev@example.com" },
    }),
    listDevices: async () => [
      ...devices,
      {
        id: "device-2",
        name: "Old laptop",
        platform: "darwin-arm64",
        lastSeenAt: "2026-07-20T12:00:00.000Z",
        revokedAt: "2026-07-21T12:00:00.000Z",
        activeWorkers: 4,
      },
    ],
  });

  const status = await service.refresh();
  assert.deepEqual(status.devices, devices);
  assert.equal(status.activeWorkers, 1);
});
