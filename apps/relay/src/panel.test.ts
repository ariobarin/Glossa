import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { loadConfig } from "./config.js";
import { pairingCodeHash } from "./pairing-code.js";
import { buildPanel } from "./panel.js";
import { RouterState } from "./router-state.js";
import type { PairingRecord, RelayStore } from "./store.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const subject = "google-oauth2|panel-user";
const pairingCode = "ABCD-EFGH";
const pairing: PairingRecord = {
  id: "00000000-0000-4000-8000-000000000003",
  deviceName: "Test PC",
  platform: "win32-x64",
  accountId: null,
  expiresAt: new Date(Date.now() + 60_000),
};

const unused = async (): Promise<never> => {
  throw new Error("Unexpected store call.");
};

function panelConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/glossa",
    GLOSSA_PUBLIC_ORIGIN: "https://relay.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://relay.glossa.test/",
    GLOSSA_PANEL_CLIENT_ID: "panel-client",
    GLOSSA_PANEL_CLIENT_SECRET: "changeme-panel-secret",
    GLOSSA_PANEL_SESSION_SECRET: "s".repeat(32),
  });
}

interface PanelHarness {
  origin: string;
  state: RouterState;
  close(): void;
}

function startPanel(
  context: test.TestContext,
  store: RelayStore,
  exchangeCode?: (code: string) => Promise<string>,
): Promise<PanelHarness> {
  const app = express();
  const state = new RouterState();
  const panel = buildPanel(panelConfig(), store, state, {
    exchangeCode: exchangeCode ?? (async () => subject),
  });
  assert.ok(panel, "panel is configured");
  app.use("/panel", panel);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  return once(server, "listening").then(() => {
    const address = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${address.port}`,
      state,
      close: () => server.close(),
    };
  });
}

function storeWith(overrides: Partial<RelayStore>): RelayStore {
  return {
    accountIdForSubject: async () => accountId,
    enrollDevice: unused,
    listDevices: async () => [],
    renameDevice: unused,
    revokeDevice: unused,
    touchDevice: unused,
    authenticateDevice: unused,
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    redeemPairing: unused,
    ...overrides,
  };
}

async function signIn(
  origin: string,
): Promise<string> {
  const login = await fetch(`${origin}/panel/auth/login`, {
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get("location")!);
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "panel-client");
  const state = authorize.searchParams.get("state")!;

  const callback = await fetch(
    `${origin}/panel/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/panel");
  const cookie = callback.headers.get("set-cookie")!;
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Lax"));
  return cookie.split(";")[0]!;
}

test("redirects an unauthenticated browser to login", async (context) => {
  const harness = await startPanel(context, storeWith({}));
  const response = await fetch(`${harness.origin}/panel`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/panel/auth/login");
});

test("creates a session cookie through the login callback", async (context) => {
  let exchangedCode: string | undefined;
  const harness = await startPanel(
    context,
    storeWith({}),
    async (code) => {
      exchangedCode = code;
      return subject;
    },
  );
  const cookie = await signIn(harness.origin);
  assert.equal(exchangedCode, "test-code");

  const response = await fetch(`${harness.origin}/panel`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes(`Signed in as ${subject}`));
});

test("rejects a tampered session cookie", async (context) => {
  const harness = await startPanel(context, storeWith({}));
  const cookie = await signIn(harness.origin);
  const response = await fetch(`${harness.origin}/panel`, {
    headers: { cookie: cookie.replace(/.$/, "x") },
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/panel/auth/login");
});

test("confirms a pairing with the session account and code hash", async (context) => {
  let claimedHash: Buffer | undefined;
  let claimedAccount: string | undefined;
  const harness = await startPanel(
    context,
    storeWith({
      findPairing: async (hash) => {
        assert.ok(hash.equals(pairingCodeHash(pairingCode)!));
        return pairing;
      },
      claimPairing: async (hash, receivedAccountId) => {
        claimedHash = hash;
        claimedAccount = receivedAccountId;
        return { ...pairing, accountId: receivedAccountId };
      },
    }),
  );
  const cookie = await signIn(harness.origin);

  const preview = await fetch(`${harness.origin}/panel/pair`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: pairingCode }),
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.text();
  assert.ok(previewBody.includes("Test PC"));
  assert.ok(previewBody.includes("/panel/pair/confirm"));

  const confirm = await fetch(`${harness.origin}/panel/pair/confirm`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: pairingCode }),
  });
  assert.equal(confirm.status, 200);
  assert.ok((await confirm.text()).includes("Paired"));
  assert.ok(claimedHash!.equals(pairingCodeHash(pairingCode)!));
  assert.equal(claimedAccount, accountId);
});

test("revokes a device for the session account", async (context) => {
  let revokedAccount: string | undefined;
  let revokedDevice: string | undefined;
  const harness = await startPanel(
    context,
    storeWith({
      revokeDevice: async (receivedAccountId, receivedDeviceId) => {
        revokedAccount = receivedAccountId;
        revokedDevice = receivedDeviceId;
        return true;
      },
    }),
  );
  harness.state.register(
    accountId,
    deviceId,
    "Test PC",
    "00000000-0000-4000-8000-000000000004",
  );
  assert.equal(harness.state.activeWorkerCount(accountId, deviceId), 1);
  const cookie = await signIn(harness.origin);
  const response = await fetch(
    `${harness.origin}/panel/devices/${deviceId}/revoke`,
    {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/panel");
  assert.equal(revokedAccount, accountId);
  assert.equal(revokedDevice, deviceId);
  assert.equal(harness.state.activeWorkerCount(accountId, deviceId), 0);
});

test("keeps workers when panel revocation does not persist", async (context) => {
  const harness = await startPanel(
    context,
    storeWith({ revokeDevice: async () => false }),
  );
  harness.state.register(
    accountId,
    deviceId,
    "Test PC",
    "00000000-0000-4000-8000-000000000004",
  );
  const cookie = await signIn(harness.origin);
  const response = await fetch(
    `${harness.origin}/panel/devices/${deviceId}/revoke`,
    {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    },
  );
  assert.equal(response.status, 303);
  assert.equal(harness.state.activeWorkerCount(accountId, deviceId), 1);
});

test("rejects a cross-origin POST", async (context) => {
  const harness = await startPanel(context, storeWith({}));
  const cookie = await signIn(harness.origin);
  const response = await fetch(`${harness.origin}/panel/pair`, {
    method: "POST",
    headers: {
      cookie,
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: pairingCode }),
  });
  assert.equal(response.status, 403);
});

test("shows an error page for an unknown pairing code", async (context) => {
  const harness = await startPanel(
    context,
    storeWith({ findPairing: async () => null }),
  );
  const cookie = await signIn(harness.origin);
  const response = await fetch(`${harness.origin}/panel/pair`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: pairingCode }),
  });
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes("Unknown or expired code"));
});

test("shows a conflict page for an already-claimed code", async (context) => {
  const harness = await startPanel(
    context,
    storeWith({
      findPairing: async () => ({ ...pairing, accountId }),
    }),
  );
  const cookie = await signIn(harness.origin);
  const response = await fetch(`${harness.origin}/panel/pair/confirm`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: pairingCode }),
  });
  assert.equal(response.status, 409);
  assert.ok((await response.text()).includes("already claimed"));
});
