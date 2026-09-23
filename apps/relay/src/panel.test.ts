import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadConfig } from "./config.js";
import { pairingCodeHash } from "./pairing-code.js";
import { buildPanel, type PanelDependencies } from "./panel.js";
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
  dependencies: PanelDependencies = { exchangeCode: async () => subject },
  config = panelConfig(),
): Promise<PanelHarness> {
  const app = express();
  const state = new RouterState();
  const panel = buildPanel(config, store, state, dependencies);
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

async function beginSignIn(origin: string) {
  const login = await fetch(`${origin}/panel/auth/login`, {
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const authorize = new URL(login.headers.get("location")!);
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "panel-client");
  const state = authorize.searchParams.get("state")!;
  const cookie = login.headers.get("set-cookie")!;
  assert.ok(cookie.includes("Path=/; HttpOnly; SameSite=Lax"));
  assert.ok(cookie.includes("Max-Age=600"));
  assert.ok(!cookie.includes("Domain="));
  if (cookie.startsWith("__Host-")) assert.ok(cookie.includes("; Secure"));
  return { authorize, state, cookie: cookie.split(";")[0]! };
}

async function signIn(origin: string): Promise<string> {
  const { state, cookie: transaction } = await beginSignIn(origin);
  const callback = await fetch(
    `${origin}/panel/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie: transaction } },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/panel");
  const cookies = callback.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.includes("panel_login=;") && cookie.includes("Max-Age=0")));
  const cookie = cookies.find((cookie) => cookie.startsWith("glossa_panel="))!;
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

test("rejects a login callback transferred to another browser", async (context) => {
  let exchanges = 0;
  const harness = await startPanel(context, storeWith({}), {
    exchangeCode: async () => {
      exchanges += 1;
      return subject;
    },
  });
  const login = await fetch(`${harness.origin}/panel/auth/login`, {
    redirect: "manual",
  });
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(
    `${harness.origin}/panel/auth/callback?code=attacker-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 400);
  assert.equal(exchanges, 0);
});

test("rejects mismatched and malformed login transactions before token exchange", async (context) => {
  let exchanges = 0;
  const harness = await startPanel(context, storeWith({}), {
    exchangeCode: async () => {
      exchanges += 1;
      return subject;
    },
  });
  const first = await beginSignIn(harness.origin);
  const second = await beginSignIn(harness.origin);
  assert.ok(first.cookie.startsWith("__Host-glossa_panel_login="));
  const cases = [
    { name: "another browser's cookie", cookie: second.cookie, state: first.state },
    { name: "tampered cookie content", cookie: first.cookie.replace("=", "=x"), state: first.state },
    { name: "tampered cookie signature", cookie: `${first.cookie}x`, state: first.state },
    { name: "extra cookie field", cookie: `${first.cookie}.extra`, state: first.state },
    { name: "missing state", cookie: first.cookie, state: "" },
    { name: "tampered state", cookie: first.cookie, state: `${first.state}x` },
    { name: "extra state field", cookie: first.cookie, state: `${first.state}.extra` },
    { name: "missing code", cookie: first.cookie, state: first.state, code: "" },
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const query = new URLSearchParams({ state: entry.state, code: entry.code ?? "test-code" });
      const response = await fetch(`${harness.origin}/panel/auth/callback?${query}`, {
        headers: { cookie: entry.cookie },
        redirect: "manual",
      });
      assert.equal(response.status, 400);
      assert.ok(response.headers.get("set-cookie")!.includes("Max-Age=0"));
      assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith("glossa_panel=")));
      assert.equal(exchanges, 0);
    });
  }
});

test("rejects a signed login transaction at its expiry", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const harness = await startPanel(context, storeWith({}), { exchangeCode: unused });
  const transaction = await beginSignIn(harness.origin);
  now += 10 * 60_000;
  const response = await fetch(
    `${harness.origin}/panel/auth/callback?code=test-code&state=${transaction.state}`,
    { headers: { cookie: transaction.cookie }, redirect: "manual" },
  );
  assert.equal(response.status, 400);
});

test("binds the real token exchange to PKCE and validates the returned identity", async (context) => {
  const config = panelConfig();
  const keys = await generateKeyPair("RS256");
  const publicKey = { ...await exportJWK(keys.publicKey), kid: "panel-test", alg: "RS256" };
  const codes = new Map<string, string>();
  let jwksReads = 0;
  const identity = express();
  identity.use(express.urlencoded({ extended: false }));
  identity.get("/authorize", (request, response) => {
    assert.equal(request.query.code_challenge_method, "S256");
    assert.equal(request.query.client_id, config.GLOSSA_PANEL!.clientId);
    assert.match(String(request.query.code_challenge), /^[A-Za-z0-9_-]{43}$/);
    const code = randomUUID();
    codes.set(code, String(request.query.code_challenge));
    const callback = new URL(String(request.query.redirect_uri));
    callback.searchParams.set("state", String(request.query.state));
    callback.searchParams.set("code", code);
    response.redirect(callback.toString());
  });
  identity.post("/oauth/token", async (request, response) => {
    assert.equal(request.body.grant_type, "authorization_code");
    assert.equal(request.body.client_id, config.GLOSSA_PANEL!.clientId);
    assert.equal(request.body.client_secret, config.GLOSSA_PANEL!.clientSecret);
    assert.equal(request.body.redirect_uri, `${config.GLOSSA_PUBLIC_ORIGIN}/panel/auth/callback`);
    const challenge = codes.get(request.body.code);
    codes.delete(request.body.code);
    const verifier = request.body.code_verifier;
    if (!challenge || typeof verifier !== "string" ||
        createHash("sha256").update(verifier).digest("base64url") !== challenge) {
      response.status(400).json({ error: "invalid_grant" });
      return;
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
      .setSubject(subject)
      .setIssuer(config.GLOSSA_AUTH0_ISSUER)
      .setAudience(config.GLOSSA_PANEL!.clientId)
      .setExpirationTime("1m")
      .sign(keys.privateKey);
    response.json({ id_token: token });
  });
  identity.get("/.well-known/jwks.json", (_request, response) => {
    jwksReads += 1;
    response.json({ keys: [publicKey] });
  });
  const server = identity.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  config.GLOSSA_AUTH0_ISSUER = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const harness = await startPanel(context, storeWith({}), {}, config);
  config.GLOSSA_PUBLIC_ORIGIN = harness.origin;

  async function authorize() {
    const transaction = await beginSignIn(harness.origin);
    assert.ok(transaction.cookie.startsWith("glossa_panel_login="));
    const authorization = await fetch(transaction.authorize, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    return { ...transaction, callback: new URL(authorization.headers.get("location")!) };
  }

  const attacker = await authorize();
  const victim = await authorize();
  attacker.callback.searchParams.set("state", victim.state);
  const substituted = await fetch(attacker.callback, {
    headers: { cookie: victim.cookie }, redirect: "manual",
  });
  assert.equal(substituted.status, 502);
  assert.equal(jwksReads, 0);
  assert.ok(!substituted.headers.getSetCookie().some((cookie) => cookie.startsWith("glossa_panel=")));

  const legitimate = await authorize();
  const callback = await fetch(legitimate.callback, {
    headers: { cookie: legitimate.cookie }, redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(jwksReads, 1);
  const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("glossa_panel="))!;
  assert.ok(session);
  const page = await fetch(`${harness.origin}/panel`, { headers: { cookie: session.split(";")[0]! } });
  assert.equal(page.status, 200);

  const browserReplay = await fetch(legitimate.callback, { redirect: "manual" });
  assert.equal(browserReplay.status, 400);
  const copiedCookieReplay = await fetch(legitimate.callback, {
    headers: { cookie: legitimate.cookie }, redirect: "manual",
  });
  assert.equal(copiedCookieReplay.status, 502);
});

test("creates a session cookie through the login callback", async (context) => {
  let exchangedCode: string | undefined;
  const harness = await startPanel(
    context,
    storeWith({}),
    {
      exchangeCode: async (code) => {
        exchangedCode = code;
        return subject;
      },
    },
  );
  const cookie = await signIn(harness.origin);
  assert.equal(exchangedCode, "test-code");

  const response = await fetch(`${harness.origin}/panel`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes('aria-label="Glossa home"'));
  assert.ok(body.includes("<title>Devices | Glossa</title>"));
  assert.ok(
    body.includes(
      '<link rel="icon" href="https://glossa.sh/glossa-symbol.svg" type="image/svg+xml">',
    ),
  );
  assert.ok(body.includes('<header class="site-header page-width">'));
  assert.ok(body.includes('aria-label="Site navigation"'));
  assert.ok(body.includes('<footer class="site-footer">'));
  assert.ok(body.includes('aria-label="Legal and support"'));
  assert.ok(body.includes("No active devices yet."));
  assert.ok(!body.includes(subject));
});

test("shows active devices without revoked history", async (context) => {
  const harness = await startPanel(
    context,
    storeWith({
      listDevices: async () => [
        {
          id: deviceId,
          accountId,
          name: "Current PC",
          platform: "win32-x64",
          revokedAt: null,
          lastSeenAt: new Date("2026-08-15T12:00:00Z"),
        },
        {
          id: "00000000-0000-4000-8000-000000000005",
          accountId,
          name: "Old PC",
          platform: "win32-x64",
          revokedAt: new Date("2026-08-14T12:00:00Z"),
          lastSeenAt: new Date("2026-08-14T11:00:00Z"),
        },
      ],
    }),
  );
  const cookie = await signIn(harness.origin);
  const response = await fetch(`${harness.origin}/panel`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("Current PC"));
  assert.ok(body.includes("2026-08-15 12:00:00 UTC"));
  assert.ok(!body.includes("Old PC"));
  assert.ok(!body.includes("revoked"));
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
