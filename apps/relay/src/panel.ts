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

const brandSymbol = `<svg class="brand-symbol" viewBox="0 0 344.5 332" aria-hidden="true">
<defs>
<linearGradient id="purple-top" x1="0" y1="169" x2="310" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#6d43f0"/><stop offset="1" stop-color="#8054ff"/></linearGradient>
<linearGradient id="purple-left" x1="0" y1="230" x2="61" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="#6840eb"/><stop offset="1" stop-color="#784dfa"/></linearGradient>
<linearGradient id="coral" x1="167" y1="169" x2="344.5" y2="332" gradientUnits="userSpaceOnUse"><stop stop-color="#ff665f"/><stop offset="1" stop-color="#fb5f59"/></linearGradient>
</defs>
<path fill="url(#purple-top)" d="M86 0H310V22C310 68 277 108 242 108H78C48 108 20 127 3 155L20 64C25 28 60 0 86 0Z"/>
<path fill="url(#purple-left)" d="M61 124V237C28 237 0 217 0 184C0 171 1 162 4 155C15 140 35 127 61 124Z"/>
<path fill="url(#coral)" d="M31.5 239.5L54 248H245L167 169H248C257 169 266 172 273 179L344.5 248.5V288C344.5 313 328 332 303 332H145C132 332 118 329 107 319Z"/>
</svg>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#111016">
<title>${escapeHtml(title)} - Glossa</title>
<style>
:root{color-scheme:dark;--paper:#111016;--surface:#17151e;--ink:#f4f1fb;--muted:#aaa4b5;--purple:#8054ff;--purple-readable:#ad98ff;--coral:#ff665f;--coral-hover:#ff7b75;--line:#2e2a3b;--line-strong:#5c556e;--radius:12px;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;--sans:"Segoe UI Variable","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}
html{min-height:100%;background:var(--paper);scrollbar-color:var(--purple) var(--paper)}
body{min-height:100vh;margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button,input{font:inherit}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--purple);outline-offset:3px}
.site-header{display:flex;min-height:68px;align-items:center;border-bottom:1px solid var(--line);background:rgba(17,16,22,.92)}
.header-inner,.panel-main{width:min(calc(100% - 48px),880px);margin-inline:auto}
.brand{display:inline-flex;align-items:center;gap:10px;font-size:17px;font-weight:700;letter-spacing:-.025em}
.brand-symbol{width:24px;height:24px}
.panel-main{padding:clamp(42px,8vw,76px) 0 80px}
.heading-row{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:30px}
h1{margin:0;font-size:clamp(34px,6vw,48px);font-weight:700;letter-spacing:-.045em;line-height:1}
h1+p{margin-top:22px}
p{margin:0 0 22px;color:var(--muted)}
p a{color:var(--purple-readable);text-decoration:underline;text-underline-offset:4px}
strong{color:var(--ink)}
.primary-action,.secondary-action,.danger-action{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border-radius:var(--radius);font-size:14px;font-weight:700;cursor:pointer}
.primary-action{padding:0 18px;border:0;background:var(--coral);color:#211011;box-shadow:0 8px 24px rgba(0,0,0,.26)}
.primary-action:hover{background:var(--coral-hover)}
.secondary-action,.danger-action{padding:0 15px;border:1px solid var(--line-strong);background:transparent;color:var(--ink)}
.secondary-action:hover{border-color:var(--purple-readable);color:var(--purple-readable)}
.danger-action{min-height:38px;color:var(--coral)}
.danger-action:hover{border-color:var(--coral);background:rgba(255,102,95,.08)}
.device-list{display:grid;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);list-style:none;overflow:hidden}
.device-card{display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,auto) auto;align-items:center;gap:24px;padding:20px 22px}
.device-card+.device-card{border-top:1px solid var(--line)}
.device-name{display:flex;min-width:0;align-items:center;gap:12px}
.device-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.platform{padding:3px 7px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-family:var(--mono);font-size:11px;white-space:nowrap}
.device-meta{display:grid;gap:2px;color:var(--muted);font-size:13px}
.device-meta span{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em}
.device-meta time{color:var(--ink);font-family:var(--mono);font-size:12px;white-space:nowrap}
.empty-state{padding:34px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);color:var(--muted);text-align:center}
.account-actions{display:flex;align-items:center;justify-content:flex-end;margin-top:24px}
.pair-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;max-width:560px}
input[type=text]{width:100%;min-height:48px;padding:0 15px;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);color:var(--ink);font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase}
.back-link{display:inline-block;margin-top:24px;color:var(--muted);font-size:14px;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:4px}
.back-link:hover{color:var(--ink);text-decoration-color:currentColor}
.confirmation{max-width:580px;padding:26px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.confirmation p:last-child{margin-bottom:0}
@media(max-width:680px){.header-inner,.panel-main{width:min(calc(100% - 28px),880px)}.panel-main{padding-top:38px}.heading-row{align-items:flex-start;flex-direction:column}.device-card{grid-template-columns:1fr auto;gap:18px}.device-meta{grid-column:1/-1;grid-row:2}.pair-form{grid-template-columns:1fr}.pair-form .primary-action{width:100%}}
</style>
</head>
<body>
<header class="site-header"><div class="header-inner"><a class="brand" href="https://glossa.sh" aria-label="Glossa home">${brandSymbol}<span>Glossa</span></a></div></header>
<main class="panel-main">${body}</main>
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

function deviceList(devices: DeviceRecord[]): string {
  const activeDevices = devices.filter((device) => !device.revokedAt);
  if (activeDevices.length === 0) {
    return '<div class="empty-state">No active devices yet.</div>';
  }
  const rows = activeDevices
    .map((device) => {
      const lastSeen = formatInstant(device.lastSeenAt);
      return `<li class="device-card">
<div class="device-name"><strong>${escapeHtml(device.name)}</strong><span class="platform">${escapeHtml(device.platform ?? "unknown")}</span></div>
<div class="device-meta"><span>Last seen</span><time>${lastSeen}</time></div>
<form method="post" action="/panel/devices/${escapeHtml(device.id)}/revoke"><button class="danger-action" type="submit">Revoke</button></form>
</li>`;
    })
    .join("\n");
  return `<ul class="device-list">${rows}</ul>`;
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
    sendPage(response, 200, "Devices", `<div class="heading-row"><h1>Devices</h1><a class="primary-action" href="/panel/pair">Pair a device</a></div>
${deviceList(devices)}
<div class="account-actions"><form method="post" action="/panel/auth/logout"><button class="secondary-action" type="submit">Sign out</button></form></div>`);
  });

  router.get("/pair", (request, response) => {
    const query = request.query as { code?: unknown };
    const code = typeof query.code === "string" ? query.code : "";
    sendPage(response, 200, "Pair a device", `<div class="heading-row"><h1>Pair a device</h1></div>
<p>Enter the pairing code shown by the Glossa CLI.</p>
<form class="pair-form" method="post" action="/panel/pair">
<input type="text" name="code" value="${escapeHtml(code)}" placeholder="XXXX-XXXX" required>
<button class="primary-action" type="submit">Continue</button>
</form>
<a class="back-link" href="/panel">Back to devices</a>`);
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
<a class="back-link" href="/panel">Back to devices</a>`);
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
<button class="primary-action" type="submit">Pair this device</button>
</form>
<a class="back-link" href="/panel/pair">Cancel</a>`);
}

function sendPairingConflict(response: Response): void {
  sendPage(response, 409, "Already claimed", `<h1>Code already claimed</h1>
<p>That pairing code has already been bound to an account. Ask the CLI for a new code.</p>
<p><a href="/panel/pair">Try another code</a></p>`);
}
