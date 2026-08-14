// Local development identity issuer. Stands in for Auth0 so the full Glossa
// integration flow (pairing, MCP, worker) runs against a local relay without
// touching production or a real tenant. NOT for deployment: it signs any
// requested identity and auto-approves device pairing after a short delay.
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKey,
  type KeyObject,
} from "jose";

const DEFAULT_PORT = 39101;
const AUTO_APPROVE_MS = 800;
const DEVICE_CODE_TTL_SECONDS = 600;

export interface DevAuthServer {
  issuer: string;
  port: number;
  close(): Promise<void>;
}

interface PendingDeviceCode {
  scope: string;
  audience: string;
  approveAt: number;
}

async function readForm(body: import("node:http").IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of body) raw += chunk;
  return new URLSearchParams(raw);
}

export async function startDevAuth(port = DEFAULT_PORT): Promise<DevAuthServer> {
  const issuer = `http://127.0.0.1:${port}/`;
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey as KeyObject);
  jwk.kid = "dev-auth-local";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks: { keys: JSONWebKey[] } = { keys: [jwk] };
  const pending = new Map<string, PendingDeviceCode>();

  const sign = async (
    subject: string,
    audience: string,
    scope: string,
  ): Promise<string> =>
    await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey as KeyObject);

  const json = (
    response: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer);
      if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
        json(response, 200, jwks);
        return;
      }
      if (request.method === "GET" && url.pathname === "/activate") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><title>Glossa local pairing</title>" +
            "<p>Glossa local development pairing is approved automatically. " +
            "Return to the terminal.</p>",
        );
        return;
      }
      // Authorization-code flow for the relay control panel: auto-login as
      // the local development identity, no consent screen.
      if (request.method === "GET" && url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        if (!redirectUri) {
          json(response, 400, { error: "invalid_request" });
          return;
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", crypto.randomUUID());
        target.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/device/code") {
        const form = await readForm(request);
        const deviceCode = crypto.randomUUID();
        const userCode = crypto.randomUUID().slice(0, 8).toUpperCase();
        pending.set(deviceCode, {
          scope: form.get("scope") ?? "",
          audience: form.get("audience") ?? issuer,
          approveAt: Date.now() + AUTO_APPROVE_MS,
        });
        setTimeout(() => pending.delete(deviceCode), DEVICE_CODE_TTL_SECONDS * 1000).unref();
        json(response, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${issuer}activate`,
          verification_uri_complete: `${issuer}activate?user_code=${userCode}`,
          expires_in: DEVICE_CODE_TTL_SECONDS,
          interval: 1,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const form = await readForm(request);
        const grantType = form.get("grant_type");
        if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
          const code = pending.get(form.get("device_code") ?? "");
          if (!code) {
            json(response, 400, { error: "expired_token" });
            return;
          }
          if (Date.now() < code.approveAt) {
            json(response, 400, { error: "authorization_pending" });
            return;
          }
          pending.delete(form.get("device_code") ?? "");
          json(response, 200, {
            access_token: await sign("dev|local-user", code.audience, code.scope),
            token_type: "Bearer",
            expires_in: 3600,
            scope: code.scope,
          });
          return;
        }
        // Authorization-code exchange for the relay control panel.
        if (grantType === "authorization_code") {
          json(response, 200, {
            access_token: await sign(
              "dev|local-user",
              form.get("audience") ?? issuer,
              "openid profile",
            ),
            id_token: await sign(
              "dev|local-user",
              form.get("client_id") ?? "dev-panel",
              "openid profile",
            ),
            token_type: "Bearer",
            expires_in: 3600,
          });
          return;
        }
        // Direct token issuance for local MCP and relay testing.
        if (grantType === "client_credentials") {
          const scope = form.get("scope") ?? "";
          json(response, 200, {
            access_token: await sign(
              form.get("sub") ?? "dev|local-user",
              form.get("audience") ?? issuer,
              scope,
            ),
            token_type: "Bearer",
            expires_in: 3600,
            scope,
          });
          return;
        }
        json(response, 400, { error: "unsupported_grant_type" });
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : "dev auth error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    issuer,
    port,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const isStandalone = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isStandalone) {
  const devAuth = await startDevAuth();
  const relayOrigin = "http://127.0.0.1:39100";
  console.log(`Glossa local development issuer listening at ${devAuth.issuer}`);
  console.log("It signs any requested identity and auto-approves pairing.");
  console.log("");
  console.log("Relay .env for local integration:");
  console.log(`  GLOSSA_AUTH0_ISSUER=${devAuth.issuer}`);
  console.log(`  GLOSSA_AUTH0_AUDIENCE=${relayOrigin}/`);
  console.log("  GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES=dev|");
  console.log("");
  console.log("Optional relay control panel at /panel:");
  console.log("  GLOSSA_PANEL_CLIENT_ID=dev-panel");
  console.log("  GLOSSA_PANEL_CLIENT_SECRET=dev-changeme");
  console.log(`  GLOSSA_PANEL_SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}`);
  console.log("");
  console.log("CLI environment for local integration:");
  console.log(`  GLOSSA_RELAY_ORIGIN=${relayOrigin}`);
  console.log(`  GLOSSA_AUTH0_ISSUER=${devAuth.issuer}`);
  console.log(`  GLOSSA_AUTH0_AUDIENCE=${relayOrigin}/`);
  console.log("  GLOSSA_AUTH0_CLI_CLIENT_ID=dev-cli");
}
