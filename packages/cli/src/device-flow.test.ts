import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCredentials } from "./config-store.js";
import {
  authorizeWithDeviceFlow,
  loginWithDeviceFlow,
  type LoginOptions,
} from "./device-flow.js";

const options: LoginOptions = {
  issuer: "https://identity.glossa.test/",
  clientId: "glossa-cli",
  audience: "https://mcp.glossa.test/",
  scope: "openid profile glossa:device",
};

function deviceFlowFetch(refreshToken?: string): typeof fetch {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({
        device_code: "device-code",
        user_code: "BROWSER-CODE",
        verification_uri: "https://identity.glossa.test/activate",
        expires_in: 300,
        interval: 1,
      });
    }
    return Response.json({
      access_token: "access-token",
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expires_in: 3600,
      token_type: "Bearer",
      scope: refreshToken ? `${options.scope} offline_access` : options.scope,
    });
  };
}

test("returns temporary browser authorization without storing it", async () => {
  const credentials = await authorizeWithDeviceFlow(options, {
    fetch: deviceFlowFetch(),
    delay: async () => undefined,
    openBrowser: async () => true,
    now: () => 0,
    log: () => undefined,
  });

  assert.equal(credentials.accessToken, "access-token");
  assert.equal(credentials.refreshToken, undefined);
  assert.equal(credentials.requestedScope, options.scope);
});

test("persistent login still requires and stores a refresh token", async () => {
  let saved: StoredCredentials | undefined;
  await loginWithDeviceFlow(
    { ...options, scope: `${options.scope} offline_access` },
    {
      fetch: deviceFlowFetch("refresh-token"),
      delay: async () => undefined,
      openBrowser: async () => true,
      saveCredentials: async (credentials) => {
        saved = credentials;
        return "file";
      },
      now: () => 0,
      log: () => undefined,
    },
  );

  assert.equal(saved?.refreshToken, "refresh-token");
});
