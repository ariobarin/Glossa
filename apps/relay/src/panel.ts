// Browser control panel for pairing-code redemption and device recovery.
// Served at /panel when the GLOSSA_PANEL_* configuration is present. Plain
// HTML forms only: no framework, no build step, no client-side JavaScript.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Router, urlencoded } from "express";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { PanelConfig, RelayConfig } from "./config.js";
import { subjectIsAllowedIdentity } from "./auth.js";
import { pairingCodeHash } from "./pairing-code.js";
import type { RouterState } from "./router-state.js";
import type { DeviceRecord, PairingRecord, RelayStore } from "./store.js";

const SESSION_COOKIE = "glossa_panel";
const SESSION_TTL_MS = 12 * 60 * 60_000;
const deviceIdSchema = z.string().uuid();

// The panel exchanges the authorization code and returns the verified
// subject. Injected in tests so no real JWKS or token endpoint is needed.
export interface PanelDependencies {
  exchangeCode?: (code: string) => Promise<string>;
}

interface PanelSession {
  subject: string;
  accountId: string;
}

interface PanelRequest extends Request {
  session?: PanelSession;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Glossa</title>
<style>
body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#222;line-height:1.5}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #ddd}
button,input{font:inherit;padding:.3rem .6rem}
input[type=text]{min-width:12rem}
.muted{color:#666;font-size:.9rem}
nav{margin-bottom:1.5rem}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function sendPage(response: Response, status: number, title: string, body: string): void {
  response.status(status).type("html").send(page(title, body));
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signatureMatches(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function encodeSession(subject: string, secret: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const signature = hmac(secret, `${subject}|${expiresAt}`);
  return `${Buffer.from(subject, "utf8").toString("base64url")}.${expiresAt}.${signature}`;
}

function decodeSession(cookie: string | undefined, secret: string): string | null {
  if (!cookie) return null;
  const [encodedSubject, expiresAtRaw, signature] = cookie.split(".");
  if (!encodedSubject || !expiresAtRaw || !signature) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  let subject: string;
  try {
    subject = Buffer.from(encodedSubject, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!signatureMatches(hmac(secret, `${subject}|${expiresAt}`), signature)) {
    return null;
  }
  return subject;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=");
  }
  return undefined;
}

function sessionCookieFlags(config: RelayConfig): string {
  const secure = config.GLOSSA_PUBLIC_ORIGIN.startsWith("https:")
    ? "; Secure"
    : "";
  return `Path=/panel; HttpOnly; SameSite=Lax${secure}`;
}

function callbackUrl(config: RelayConfig): string {
  return `${config.GLOSSA_PUBLIC_ORIGIN.replace(/\/$/, "")}/panel/auth/callback`;
}

function issuerUrl(config: RelayConfig, path: string): URL {
  const issuer = config.GLOSSA_AUTH0_ISSUER.endsWith("/")
    ? config.GLOSSA_AUTH0_ISSUER
    : `${config.GLOSSA_AUTH0_ISSUER}/`;
  return new URL(path, issuer);
}

async function exchangeCodeForSubject(
  config: RelayConfig,
  panel: PanelConfig,
  code: string,
): Promise<string> {
  const tokenResponse = await fetch(issuerUrl(config, "oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: panel.clientId,
      client_secret: panel.clientSecret,
      code,
      redirect_uri: callbackUrl(config),
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed with ${tokenResponse.status}.`);
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("Token exchange returned no id_token.");
  const jwks = createRemoteJWKSet(
    issuerUrl(config, ".well-known/jwks.json"),
    { timeoutDuration: 5_000 },
  );
  const issuer = config.GLOSSA_AUTH0_ISSUER.endsWith("/")
    ? config.GLOSSA_AUTH0_ISSUER
    : `${config.GLOSSA_AUTH0_ISSUER}/`;
  const verified = await jwtVerify(tokens.id_token, jwks, {
    issuer,
    audience: panel.clientId,
  });
  if (!verified.payload.sub) throw new Error("Identity token has no subject.");
  return verified.payload.sub;
}

function formatInstant(value: Date | null): string {
  return value ? value.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never";
}

function deviceRows(devices: DeviceRecord[]): string {
  if (devices.length === 0) {
    return "<p>No devices paired to this account.</p>";
  }
  const rows = devices
    .map((device) => {
      const status = device.revokedAt ? "revoked" : "active";
      const action = device.revokedAt
        ? ""
        : `<form method="post" action="/panel/devices/${escapeHtml(device.id)}/revoke"><button type="submit">Revoke</button></form>`;
      return `<tr><td>${escapeHtml(device.name)}</td><td>${escapeHtml(device.platform ?? "unknown")}</td><td>${formatInstant(device.lastSeenAt)}</td><td>${status}</td><td>${action}</td></tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr><th>Name</th><th>Platform</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function codeFromBody(request: Request): string | null {
  const body = request.body as { code?: unknown } | undefined;
  return typeof body?.code === "string" && body.code ? body.code : null;
}

export function buildPanel(
  config: RelayConfig,
  store: RelayStore,
  state: RouterState,
  dependencies: PanelDependencies = {},
): Router | undefined {
  const panel = config.GLOSSA_PANEL;
  if (!panel) return undefined;
  const exchangeCode =
    dependencies.exchangeCode ??
    ((code: string) => exchangeCodeForSubject(config, panel, code));

  const router = Router();
  router.use(urlencoded({ extended: false, limit: "8kb" }));

  // Cross-site request forgery defense: the session cookie is SameSite=Lax,
  // and state-changing POSTs additionally reject a mismatched Origin header.
  router.use((request, response, next) => {
    if (request.method === "POST") {
      const origin = request.header("origin");
      if (
        origin &&
        origin !== config.GLOSSA_PUBLIC_ORIGIN.replace(/\/$/, "")
      ) {
        sendPage(response, 403, "Forbidden", "<h1>Forbidden</h1><p>Cross-origin form submissions are not accepted.</p>");
        return;
      }
    }
    next();
  });

  router.get("/auth/login", (_request, response) => {
    const state = randomBytes(16).toString("base64url");
    const signedState = `${state}.${hmac(panel.sessionSecret, `state|${state}`)}`;
    const authorize = issuerUrl(config, "authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", panel.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(config));
    authorize.searchParams.set("scope", "openid profile");
    authorize.searchParams.set("audience", config.GLOSSA_AUTH0_AUDIENCE);
    authorize.searchParams.set("state", signedState);
    response.redirect(authorize.toString());
  });

  router.get("/auth/callback", async (request, response) => {
    const query = request.query as { code?: unknown; state?: unknown };
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const [stateValue, stateSignature] = state.split(".");
    if (
      !code ||
      !stateValue ||
      !stateSignature ||
      !signatureMatches(
        hmac(panel.sessionSecret, `state|${stateValue}`),
        stateSignature,
      )
    ) {
      sendPage(response, 400, "Sign-in failed", "<h1>Sign-in failed</h1><p>Invalid sign-in response. <a href=\"/panel/auth/login\">Try again</a>.</p>");
      return;
    }
    let subject: string;
    try {
      subject = await exchangeCode(code);
    } catch {
      sendPage(response, 502, "Sign-in failed", "<h1>Sign-in failed</h1><p>The identity provider could not be reached. <a href=\"/panel/auth/login\">Try again</a>.</p>");
      return;
    }
    if (!subjectIsAllowedIdentity(config, subject)) {
      sendPage(response, 403, "Not allowed", "<h1>Not allowed</h1><p>This identity provider account is not permitted to use this relay.</p>");
      return;
    }
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeSession(subject, panel.sessionSecret)}; ${sessionCookieFlags(config)}; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    response.redirect("/panel");
  });

  router.post("/auth/logout", (_request, response) => {
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=; ${sessionCookieFlags(config)}; Max-Age=0`,
    );
    response.redirect(303, "/panel");
  });

  // Everything below requires a valid session bound to an active account.
  router.use(async (request: PanelRequest, response, next) => {
    const subject = decodeSession(
      readCookie(request, SESSION_COOKIE),
      panel.sessionSecret,
    );
    if (!subject) {
      response.redirect("/panel/auth/login");
      return;
    }
    const accountId = await store.accountIdForSubject(subject);
    if (!accountId) {
      sendPage(response, 403, "Account unavailable", "<h1>Account unavailable</h1><p>This account is disabled.</p>");
      return;
    }
    request.session = { subject, accountId };
    next();
  });

  router.get("/", async (request: PanelRequest, response) => {
    const devices = await store.listDevices(request.session!.accountId);
    sendPage(response, 200, "Devices", `<h1>Glossa devices</h1>
<nav><a href="/panel/pair">Pair a new device</a></nav>
${deviceRows(devices)}
<p class="muted">Signed in as ${escapeHtml(request.session!.subject)}</p>
<form method="post" action="/panel/auth/logout"><button type="submit">Sign out</button></form>`);
  });

  router.get("/pair", (request, response) => {
    const query = request.query as { code?: unknown };
    const code = typeof query.code === "string" ? query.code : "";
    sendPage(response, 200, "Pair a device", `<h1>Pair a device</h1>
<p>Enter the pairing code shown by the Glossa CLI.</p>
<form method="post" action="/panel/pair">
<input type="text" name="code" value="${escapeHtml(code)}" placeholder="XXXX-XXXX" required>
<button type="submit">Continue</button>
</form>
<p class="muted"><a href="/panel">Back to devices</a></p>`);
  });

  router.post("/pair", async (request: PanelRequest, response) => {
    const code = codeFromBody(request);
    const codeHash = code ? pairingCodeHash(code) : null;
    const pairing = codeHash ? await store.findPairing(codeHash) : null;
    if (!pairing) {
      sendPage(response, 404, "Unknown code", `<h1>Unknown or expired code</h1>
<p>That pairing code is not recognized. Codes expire after ten minutes; ask the CLI for a new one.</p>
<p><a href="/panel/pair">Try another code</a></p>`);
      return;
    }
    sendPairingConfirmation(response, code!, pairing);
  });

  router.post("/pair/confirm", async (request: PanelRequest, response) => {
    const code = codeFromBody(request);
    const codeHash = code ? pairingCodeHash(code) : null;
    const pairing = codeHash ? await store.findPairing(codeHash) : null;
    if (!pairing) {
      sendPage(response, 404, "Unknown code", `<h1>Unknown or expired code</h1>
<p>That pairing code is not recognized. Codes expire after ten minutes; ask the CLI for a new one.</p>
<p><a href="/panel/pair">Try another code</a></p>`);
      return;
    }
    if (pairing.accountId) {
      sendPairingConflict(response);
      return;
    }
    const claimed = await store.claimPairing(
      codeHash!,
      request.session!.accountId,
    );
    if (!claimed) {
      sendPairingConflict(response);
      return;
    }
    sendPage(response, 200, "Paired", `<h1>Paired</h1>
<p><strong>${escapeHtml(claimed.deviceName)}</strong> is now paired to your account.</p>
<p>Return to the terminal; Glossa will connect within a few seconds.</p>
<p class="muted"><a href="/panel">Back to devices</a></p>`);
  });

  router.post("/devices/:deviceId/revoke", async (request: PanelRequest, response) => {
    const rawDeviceId = request.params.deviceId;
    const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
    const parsed = deviceIdSchema.safeParse(deviceId);
    if (!parsed.success) {
      sendPage(response, 404, "Unknown device", "<h1>Unknown device</h1><p><a href=\"/panel\">Back to devices</a></p>");
      return;
    }
    const revoked = await store.revokeDevice(
      request.session!.accountId,
      parsed.data,
    );
    if (revoked) state.unregisterDevice(parsed.data);
    response.redirect(303, "/panel");
  });

  return router;
}

function sendPairingConfirmation(
  response: Response,
  code: string,
  pairing: PairingRecord,
): void {
  sendPage(response, 200, "Confirm pairing", `<h1>Confirm pairing</h1>
<p>Pair <strong>${escapeHtml(pairing.deviceName)}</strong> (${escapeHtml(pairing.platform ?? "unknown platform")}) to your account?</p>
<form method="post" action="/panel/pair/confirm">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<button type="submit">Pair this device</button>
</form>
<p class="muted"><a href="/panel/pair">Cancel</a></p>`);
}

function sendPairingConflict(response: Response): void {
  sendPage(response, 409, "Already claimed", `<h1>Code already claimed</h1>
<p>That pairing code has already been bound to an account. Ask the CLI for a new code.</p>
<p><a href="/panel/pair">Try another code</a></p>`);
}
