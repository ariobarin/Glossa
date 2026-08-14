import assert from "node:assert/strict";
import test from "node:test";
import { authorizePairing, type PairingOptions } from "./device-flow.js";

const options: PairingOptions = {
  issuer: "https://identity.glossa.test/",
  clientId: "glossa-cli",
  audience: "https://mcp.glossa.test/",
  scope: "openid profile glossa:device",
};

function deviceFlowFetch(): typeof fetch {
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
      expires_in: 3600,
      token_type: "Bearer",
      scope: options.scope,
    });
  };
}

test("returns temporary browser authorization without storing it", async () => {
  const authorization = await authorizePairing(options, {
    fetch: deviceFlowFetch(),
    delay: async () => undefined,
    openBrowser: async () => true,
    now: () => 0,
    log: () => undefined,
  });

  assert.deepEqual(authorization, {
    accessToken: "access-token",
    tokenType: "Bearer",
  });
});

test("rejects a grant missing the required pairing scope", async () => {
  let calls = 0;
  await assert.rejects(
    authorizePairing(options, {
      fetch: async () => {
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
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid",
        });
      },
      delay: async () => undefined,
      openBrowser: async () => true,
      now: () => 0,
      log: () => undefined,
    }),
    /did not grant the permissions/,
  );
});
