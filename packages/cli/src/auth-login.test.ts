import assert from "node:assert/strict";
import test from "node:test";
import { signedInSession } from "./auth-login.js";
import type { StoredCredentials } from "./config-store.js";
import type { LoginOptions } from "./device-flow.js";

const scope = "openid profile email offline_access";

function credentials(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    issuer: "https://auth.glossa.test",
    clientId: "glossa-cli",
    audience: "https://relay.glossa.test",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(0).toISOString(),
    tokenType: "Bearer",
    scope,
    requestedScope: scope,
    ...overrides,
  };
}

function loginOptions(signal: AbortSignal): LoginOptions {
  return {
    issuer: "https://auth.glossa.test",
    clientId: "glossa-cli",
    audience: "https://relay.glossa.test",
    scope,
    signal,
  };
}

test("forwards cancellation while validating matching stored credentials", async () => {
  const controller = new AbortController();
  const stored = credentials();
  let loginCalled = false;

  const pending = signedInSession(loginOptions(controller.signal), {
    loadCredentials: async () => ({ credentials: stored, backend: "file" }),
    validCredentials: async (received, dependencies) => {
      assert.equal(received, stored);
      assert.ok(Date.parse(received.expiresAt) < Date.now());
      assert.equal(dependencies?.signal, controller.signal);

      const signal = dependencies?.signal;
      return await new Promise<StoredCredentials>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("Credential validation did not receive an abort signal."));
          return;
        }
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    loginWithDeviceFlow: async () => {
      loginCalled = true;
    },
  });

  controller.abort();

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(loginCalled, false);
});

test("returns validated credentials without loading them twice", async () => {
  const controller = new AbortController();
  const stored = credentials({ expiresAt: "2099-01-01T00:00:00.000Z" });
  const validated = { ...stored, accessToken: "validated" };
  let loads = 0;

  const result = await signedInSession(loginOptions(controller.signal), {
    loadCredentials: async () => {
      loads += 1;
      return { credentials: stored, backend: "file" };
    },
    validCredentials: async () => validated,
    loginWithDeviceFlow: async () => {
      throw new Error("login should not run");
    },
  });

  assert.equal(loads, 1);
  assert.equal(result.loginPerformed, false);
  assert.equal(result.credentials, validated);
});
