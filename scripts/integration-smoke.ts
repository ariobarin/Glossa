// Full local integration smoke: mock issuer + local relay + real CLI pairing,
// device-credential management, and an MCP read_file roundtrip through a live
// worker. Runs entirely against local processes; no production tenant or
// relay is touched. Requires local Postgres (npm run dev:setup).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevAuth, type DevAuthServer } from "./dev-auth.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = process.env.GLOSSA_INTEGRATION_DATABASE_URL ??
  "postgres://glossa:glossa@localhost:55432/glossa";
const relayOrigin = process.env.GLOSSA_INTEGRATION_RELAY_ORIGIN ??
  "http://127.0.0.1:39100";
const audience = `${relayOrigin}/`;
const relayPort = new URL(relayOrigin).port || "80";

const temporaryPaths: string[] = [];
let relay: ChildProcess | undefined;
let devAuth: DevAuthServer | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function waitForHealthz(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${relayOrigin}/healthz`);
      if (response.ok) return;
    } catch {
      // Relay is not listening yet.
    }
    if (relay?.exitCode !== null && relay?.exitCode !== undefined) {
      throw new Error(`Relay exited early with code ${relay.exitCode}.`);
    }
    if (Date.now() > deadline) throw new Error("Relay did not start in time.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function issueToken(scope: string): Promise<string> {
  const response = await fetch(`${devAuth!.issuer}oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      sub: "dev|local-user",
      scope,
      audience,
    }),
  });
  const data = await response.json() as { access_token?: string };
  assert.ok(data.access_token, "dev issuer returned a token");
  return data.access_token;
}

async function main(): Promise<void> {
  // Point the CLI's config and auth at local throwaway state before importing
  // any CLI module: device-store resolves the config directory at import time.
  const configHome = await temporaryDirectory("glossa-smoke-config-");
  process.env.APPDATA = configHome;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.GLOSSA_RELAY_ORIGIN = relayOrigin;

  devAuth = await startDevAuth();
  process.env.GLOSSA_AUTH0_ISSUER = devAuth.issuer;
  process.env.GLOSSA_AUTH0_AUDIENCE = audience;

  relay = spawn(
    process.execPath,
    ["--import", "tsx", "apps/relay/src/index.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: relayPort,
        DATABASE_URL: databaseUrl,
        GLOSSA_PUBLIC_ORIGIN: relayOrigin,
        GLOSSA_AUTH0_ISSUER: devAuth.issuer,
        GLOSSA_AUTH0_AUDIENCE: audience,
        GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: "dev|",
        GLOSSA_WORKER_POLL_MS: "500",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitForHealthz();
  console.log("relay: up with the local development issuer");

  const { pairDevice } = await import("../packages/cli/src/device-pairing.js");
  const deviceStore = await import("../packages/cli/src/device-store.js");
  const {
    listDevices,
    loadRelayEndpoints,
    revokePairedDevice,
  } = await import("../packages/cli/src/relay-client.js");
  const { runManagedSession } = await import(
    "../packages/cli/src/worker/managed-session.js"
  );

  const endpoints = loadRelayEndpoints(process.env);

  // 1. Pairing: the CLI shows a pairing code; the smoke claims it through the
  // same authenticated endpoint the control panel uses.
  const pairingLogs: string[] = [];
  const pairing = pairDevice(endpoints, undefined, {
    log: (message) => {
      pairingLogs.push(message);
      console.log(`pairing: ${message}`);
    },
  });
  const code = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("CLI did not print a pairing code")),
      15_000,
    );
    const poll = setInterval(() => {
      const line = pairingLogs.find((message) => message.startsWith("Pairing code: "));
      const match = line?.match(/^Pairing code: (\S+)/);
      if (match) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(match[1]!);
      }
    }, 50);
  });
  const claim = await fetch(`${relayOrigin}/v1/pairings/${encodeURIComponent(code)}/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${await issueToken("glossa:device")}` },
  });
  assert.ok(claim.ok, `claiming the pairing code failed with HTTP ${claim.status}`);
  const device = await pairing;
  await deviceStore.saveDeviceCredential(device);
  assert.equal((await deviceStore.loadDeviceCredential())?.deviceId, device.deviceId);
  console.log(`pairing: enrolled as ${device.deviceName}`);

  // 2. Management with only the device credential.
  const devices = await listDevices(endpoints, `Device ${device.token}`);
  assert.ok(
    devices.some((entry) => entry.id === device.deviceId && entry.revokedAt === null),
    "device credential lists the paired device",
  );
  console.log("management: device credential lists account devices");

  // 3. MCP session with a locally issued token.
  const mcp = new Client({ name: "glossa-integration-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${relayOrigin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${await issueToken("glossa:access")}` } },
  });
  await mcp.connect(transport);
  const offline = await mcp.callTool({ name: "list_workspaces", arguments: {} });
  assert.equal(
    (offline.structuredContent as { availability: string }).availability,
    "offline",
  );
  console.log("mcp: connected, no workspaces yet");

  // 4. Live worker and a read_file roundtrip through the relay.
  const workspace = await temporaryDirectory("glossa-smoke-workspace-");
  await writeFile(path.join(workspace, "hello.txt"), "local integration works\n");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfKkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(workspace, "pixel.png"), png);
  const sessionController = new AbortController();
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("worker did not connect")), 15_000);
    void (async () => {
      try {
        await runManagedSession(workspace, endpoints, {
          device,
          workerVersion: "0.0.0-dev",
          accessProfile: "workspace",
          signal: sessionController.signal,
          quiet: true,
          handleProcessSignals: false,
          onEvent: (event) => {
            if (event.type === "status" && event.status.state === "connected") {
              clearTimeout(timeout);
              resolve();
            }
          },
        });
      } catch {
        // Aborted during teardown.
      } finally {
        clearTimeout(timeout);
        resolve();
      }
    })();
  });
  await connected;
  console.log("worker: connected through the local relay");

  const online = await mcp.callTool({ name: "list_workspaces", arguments: {} });
  const workspaces = (online.structuredContent as {
    workspaces: Array<{ workspaceId: string }>;
  }).workspaces;
  assert.equal(workspaces.length, 1, "one online workspace");

  const read = await mcp.callTool({
    name: "read_file",
    arguments: { workspaceId: workspaces[0]!.workspaceId, path: "hello.txt" },
  });
  assert.match(JSON.stringify(read.structuredContent), /local integration works/);
  console.log("mcp: read_file roundtrip returned workspace content");

  const image = await mcp.callTool({
    name: "view_image",
    arguments: { workspaceId: workspaces[0]!.workspaceId, path: "pixel.png" },
  });
  assert.equal(image.isError, undefined);
  assert.equal(image.content.length, 1);
  const imageContent = image.content[0];
  assert.ok(imageContent && imageContent.type === "image");
  assert.equal(imageContent.mimeType, "image/png");
  assert.equal(imageContent.data, png.toString("base64"));
  const imageMetadata = image.structuredContent as {
    mimeType: string;
    bytes: number;
    sha256: string;
  };
  assert.equal(imageMetadata.mimeType, "image/png");
  assert.equal(imageMetadata.bytes, png.byteLength);
  assert.match(imageMetadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal("data" in imageMetadata, false);
  console.log("mcp: view_image roundtrip returned native image content only");

  // 5. Teardown also exercises self-revocation.
  sessionController.abort();
  await revokePairedDevice(endpoints, device);
  await mcp.close();
  console.log("unpair: device credential revoked");
}

try {
  await main();
  console.log("Local integration smoke passed.");
} finally {
  relay?.kill();
  await devAuth?.close();
  await Promise.all(
    temporaryPaths.map(async (directory) =>
      await rm(directory, { recursive: true, force: true })),
  );
}
