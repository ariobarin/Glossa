import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCredentials } from "./config-store.js";
import type { StoredDeviceCredential } from "./device-store.js";
import { pairDevice } from "./device-pairing.js";
import type { RelayEndpoints } from "./relay-client.js";

const endpoints: RelayEndpoints = {
  relayOrigin: "https://mcp.glossa.test",
  workerOrigin: "https://mcp.glossa.test",
};
const credentials: StoredCredentials = {
  issuer: "https://identity.glossa.test/",
  clientId: "client",
  audience: "https://mcp.glossa.test/",
  accessToken: "access",
  expiresAt: "2099-01-01T00:00:00.000Z",
  tokenType: "Bearer",
  scope: "openid profile glossa:device",
  requestedScope: "openid profile glossa:device",
};
const pairedDevice: StoredDeviceCredential = {
  relayOrigin: endpoints.relayOrigin,
  deviceId: "00000000-0000-4000-8000-000000000002",
  deviceName: "gpu-box",
  token: "gld_00000000-0000-4000-8000-000000000002_placeholder",
};

test("authorizes in the browser without retaining account credentials", async () => {
  const messages: string[] = [];
  let receivedScope = "";
  const paired = await pairDevice(endpoints, undefined, {
    defaultDeviceName: () => "gpu-box",
    loadAuthConfig: () => ({
      issuer: credentials.issuer,
      clientId: credentials.clientId,
      audience: credentials.audience,
      scope: "openid profile offline_access glossa:device",
    }),
    authorizeWithDeviceFlow: async (options) => {
      receivedScope = options.scope;
      return credentials;
    },
    enrollDevice: async (_endpoints, receivedCredentials, name) => {
      assert.equal(receivedCredentials, credentials);
      assert.equal(name, "gpu-box");
      return pairedDevice;
    },
    log: (message) => messages.push(message),
  });

  assert.equal(paired, pairedDevice);
  assert.equal(receivedScope, "openid profile glossa:device");
  assert.ok(messages.includes("This computer needs to be paired with Glossa."));
  assert.ok(messages.includes("Paired with Glossa as gpu-box."));
});

test("cancels pairing when the managed session aborts", async () => {
  const controller = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const pending = pairDevice(endpoints, controller.signal, {
    loadAuthConfig: () => ({
      issuer: credentials.issuer,
      clientId: credentials.clientId,
      audience: credentials.audience,
      scope: "openid profile offline_access glossa:device",
    }),
    authorizeWithDeviceFlow: async (options) => {
      resolveStarted();
      return await new Promise<StoredCredentials>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
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
