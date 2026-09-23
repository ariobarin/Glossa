// Full local integration smoke: mock issuer + local relay + real CLI pairing,
// device-credential management, and an MCP read_file roundtrip through a live
// worker. Runs entirely against local processes; no production tenant or
// relay is touched. Requires npm run build and local Postgres.
import "./fixtures/isolated-cli.mjs";
import { once } from "node:events";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
let cli: ChildProcess | undefined;
let cliOutput = "";

function startHeadless(workspace: string, access: string): void {
  cliOutput = "";
  cli = spawn(process.execPath, [
    "--import", new URL("./fixtures/isolated-cli.mjs", import.meta.url).href,
    "packages/cli/dist/main.js", "--headless", "--access", access,
    "--label", "integration-smoke",
    ...(process.argv.includes("--keep-awake") ? ["--keep-awake"] : []),
    workspace,
  ], { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  for (const stream of [cli.stdout!, cli.stderr!]) {
    stream.setEncoding("utf8");
    stream.on("data", (text: string) => { cliOutput = (cliOutput + text).slice(-65_536); });
  }
}

async function waitForWorker(mcp: Client, access: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.equal(cli?.exitCode, null, `headless CLI exited early: ${cliOutput}`);
    const result = await mcp.callTool({ name: "list_workspaces", arguments: {} });
    const workers = (result.structuredContent as {
      workspaces: Array<{ workspaceId: string; workspaceLabel?: string; accessProfile: string }>;
    }).workspaces;
    if (workers.length === 1) {
      assert.equal(workers[0]!.workspaceLabel, "integration-smoke");
      assert.equal(workers[0]!.accessProfile, access);
      return workers[0]!.workspaceId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Headless worker did not connect: ${cliOutput}`);
}

async function stopHeadless(): Promise<void> {
  if (!cli || cli.exitCode !== null) return;
  const closed = once(cli, "close", { signal: AbortSignal.timeout(10_000) });
  if (process.platform === "win32") cli.send!("stop");
  else cli.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0, `headless CLI failed to shut down: ${cliOutput}`);
  assert.doesNotMatch(cliOutput, /\u001b\[|local integration works|headless-command-ok/);
  cli = undefined;
}

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

  devAuth = await startDevAuth(Number(process.env.GLOSSA_INTEGRATION_AUTH_PORT ?? 39101));
  process.env.GLOSSA_AUTH0_ISSUER = devAuth.issuer;
  process.env.GLOSSA_AUTH0_AUDIENCE = audience;

  execFileSync(process.execPath, ["apps/relay/dist/src/migrate.js"], {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_ENV: "development", DATABASE_URL: databaseUrl },
    stdio: "inherit",
    timeout: 30_000,
  });

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
  const { AsyncEntry } = await import("@napi-rs/keyring");
  assert.throws(() => new AsyncEntry("Glossa", "device"), /isolated test keyring/);
  const { configureUpdates } = await import("../packages/cli/src/update-state.js");
  await configureUpdates("0.0.0", { policy: "off" });

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
  startHeadless(workspace, "workspace");
  const workspaces = [{ workspaceId: await waitForWorker(mcp, "workspace") }];
  console.log("worker: built headless CLI connected without a terminal");

  const read = await mcp.callTool({
    name: "read_file",
    arguments: { workspaceId: workspaces[0]!.workspaceId, path: "hello.txt" },
  });
  assert.match(JSON.stringify(read.structuredContent), /local integration works/);
  console.log("mcp: read_file roundtrip returned workspace content");

  const callWorkerTool = async (
    name: string, args: Record<string, unknown>, workspaceId = workspaces[0]!.workspaceId,
  ) => {
    const result = await mcp.callTool({ name, arguments: { ...args, workspaceId } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  };
  assert.equal((await callWorkerTool("make_directory", { path: "roundtrip" })).created, true);
  const revision = await callWorkerTool("write_file", { path: "roundtrip/note.txt", content: "first\nsecond\n" });
  assert.match(revision.sha256 as string, /^[a-f0-9]{64}$/);
  const listing = await callWorkerTool("list_files", { path: "roundtrip" });
  assert.deepEqual(listing.entries, [{ path: "roundtrip/note.txt", type: "file", bytes: 13 }]);
  const range = await callWorkerTool("read_file_range", { path: "roundtrip/note.txt", startLine: 2, lineCount: 1 });
  assert.equal((range.content as string).trimEnd(), "second");
  assert.equal(range.startLine, 2);
  assert.equal(range.endLine, 2);
  const search = await callWorkerTool("search_text", { path: "roundtrip", query: "second" });
  assert.deepEqual(search.matches, [{ path: "roundtrip/note.txt", line: 2, column: 1, text: "second", lineTruncated: false }]);
  const edited = await callWorkerTool("edit_file", {
    path: "roundtrip/note.txt", expectedSha256: revision.sha256,
    edits: [{ oldText: "second", newText: "updated" }],
  });
  assert.equal(edited.replacements, 1);
  assert.equal((await callWorkerTool("move_path", { source: "roundtrip/note.txt", destination: "moved.txt" })).movedType, "file");
  assert.equal(await readFile(path.join(workspace, "moved.txt"), "utf8"), "first\nupdated\n");
  assert.equal((await callWorkerTool("delete_path", { path: "moved.txt" })).deletedType, "file");
  assert.equal((await callWorkerTool("delete_path", { path: "roundtrip" })).deletedType, "directory");
  await assert.rejects(readFile(path.join(workspace, "moved.txt")), { code: "ENOENT" });
  const missing = await mcp.callTool({
    name: "read_file", arguments: { workspaceId: workspaces[0]!.workspaceId, path: "moved.txt" },
  });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.content), /path_not_found/);
  assert.match(JSON.stringify(missing.content), /The requested path does not exist/);
  assert.doesNotMatch(JSON.stringify(missing.content), /ENOENT/);
  console.log("mcp: filesystem mutations, traversal, revision guard and safe missing-file error passed");

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

  // A hostile pattern must not strand the built worker or its read capacity.
  const patternFile = "a".repeat(64) + ".txt";
  await writeFile(path.join(workspace, patternFile), "const result = foo(bar); const more = 1;");
  for (const search of [
    { query: "^(.+)+$z", matchMode: "regex" },
    { query: "result", includeGlobs: ["*a".repeat(8) + "z"] },
    { query: "result", excludeGlobs: ["*a".repeat(8) + "z"] },
  ]) {
    const started = performance.now();
    const timedOut = await mcp.callTool({
      name: "search_text",
      arguments: { workspaceId: workspaces[0]!.workspaceId, path: patternFile, ...search },
    });
    assert.equal(timedOut.isError, true);
    assert.match(JSON.stringify(timedOut.content), /scan_timeout/);
    assert.ok(performance.now() - started < 12_000, "search outlived its local deadline");
    const recovered = await mcp.callTool({
      name: "search_text",
      arguments: { workspaceId: workspaces[0]!.workspaceId, path: patternFile, query: "result", matchMode: "regex" },
    });
    assert.notEqual(recovered.isError, true);
    assert.equal((recovered.structuredContent as { matches: unknown[] }).matches.length, 1);
  }
  console.log("search: regex and both glob deadlines plus built-worker recovery passed");

  // 5. Permission enforcement and clean restart through the built entrypoint.
  const command = { argv: [process.execPath, "-e", "console.log('headless-command-ok')"] };
  const denied = await mcp.callTool({
    name: "run_command", arguments: { workspaceId: workspaces[0]!.workspaceId, command },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /command_access_disabled/);
  const written = await mcp.callTool({
    name: "write_file",
    arguments: { workspaceId: workspaces[0]!.workspaceId, path: "written.txt", content: "headless write" },
  });
  assert.notEqual(written.isError, true);
  await stopHeadless();
  const disconnected = await mcp.callTool({ name: "list_workspaces", arguments: {} });
  assert.equal((disconnected.structuredContent as { availability: string }).availability, "offline");

  startHeadless(workspace, "read-only");
  const readOnlyId = await waitForWorker(mcp, "read-only");
  const forbiddenWrite = await mcp.callTool({
    name: "write_file", arguments: { workspaceId: readOnlyId, path: "forbidden.txt", content: "must not write" },
  });
  assert.equal(forbiddenWrite.isError, true);
  assert.match(JSON.stringify(forbiddenWrite.content), /write_access_disabled/);
  await stopHeadless();

  startHeadless(workspace, "system");
  const systemId = await waitForWorker(mcp, "system");
  const executed = await mcp.callTool({
    name: "run_command", arguments: { workspaceId: systemId, command, waitMs: 5_000 },
  });
  assert.notEqual(executed.isError, true);
  assert.match(JSON.stringify(executed.structuredContent), /headless-command-ok/);
  const commandId = (executed.structuredContent as { commandId: string }).commandId;
  assert.equal((await callWorkerTool("get_command", { commandId }, systemId)).status, "succeeded");
  const output = await callWorkerTool("read_command_output", { commandId, stream: "stdout", offset: 0, maxBytes: 128 }, systemId);
  assert.match(output.content as string, /headless-command-ok/);
  assert.equal((await callWorkerTool("cancel_command", { commandId }, systemId)).status, "succeeded");
  console.log("mcp: command status, output ranges and completed-command cancel idempotence passed");

  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => callWorkerTool(
    "run_command", {
      command: { argv: [process.execPath, "-e", `process.stdout.write(JSON.stringify({index:${index},pid:process.pid})); setTimeout(() => {}, 30000)`] },
      timeoutMs: 60_000, waitMs: 0,
    }, systemId,
  )));
  const childPids: number[] = [];
  for (const [index, started] of concurrent.entries()) {
    const ready = await callWorkerTool("get_command", { commandId: started.commandId, afterSequence: 0, waitMs: 5_000 }, systemId);
    assert.equal(ready.status, "running");
    const identity = JSON.parse(ready.stdout as string) as { index: number; pid: number };
    assert.equal(identity.index, index);
    assert.ok(Number.isInteger(identity.pid) && identity.pid > 0);
    childPids.push(identity.pid);
  }
  const overCapacity = await mcp.callTool({
    name: "run_command", arguments: { workspaceId: systemId, command, waitMs: 0 },
  });
  assert.equal(overCapacity.isError, true);
  assert.match(JSON.stringify(overCapacity.content), /command_busy/);
  assert.match(JSON.stringify(overCapacity.content), /concurrent command limit/);

  const observing = callWorkerTool("get_command", { commandId: concurrent[0]!.commandId, waitMs: 15_000 }, systemId);
  const cancelStarted = performance.now();
  assert.match((await callWorkerTool("read_file", { path: "hello.txt" }, systemId)).content as string, /local integration works/);
  assert.equal((await callWorkerTool("cancel_command", { commandId: concurrent[0]!.commandId }, systemId)).status, "canceled");
  assert.equal((await observing).status, "canceled");
  assert.ok(performance.now() - cancelStarted < 10_000, "status observation blocked reads or cancellation");
  for (const started of concurrent.slice(1)) {
    assert.equal((await callWorkerTool("get_command", { commandId: started.commandId }, systemId)).status, "running");
  }
  const retained = await callWorkerTool("read_command_output", { commandId: concurrent[1]!.commandId, stream: "stdout" }, systemId);
  assert.equal((JSON.parse(retained.content as string) as { pid: number }).pid, childPids[1]);
  assert.equal((await callWorkerTool("run_command", { command, waitMs: 5_000 }, systemId)).status, "succeeded");
  console.log("mcp: four-command cap, independent output, live cancellation, responsive reads and slot reuse passed");
  await stopHeadless();
  for (const pid of childPids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  console.log("headless: all access profiles, silent output, shutdown of every child process and restart passed");

  // 6. Teardown also exercises self-revocation.
  await revokePairedDevice(endpoints, device);
  await mcp.close();
  console.log("unpair: device credential revoked");

  // Exercise explicit local recovery through the built CLI with an offline relay.
  const relayClosed = once(relay!, "close", { signal: AbortSignal.timeout(10_000) });
  relay!.kill();
  await relayClosed;
  relay = undefined;
  cliOutput = "";
  cli = spawn(process.execPath, [
    "--import", new URL("./fixtures/isolated-cli.mjs", import.meta.url).href,
    "packages/cli/dist/main.js", "unpair",
  ], { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [cli.stdout!, cli.stderr!]) {
    stream.on("data", (text: Buffer) => { cliOutput = (cliOutput + text.toString()).slice(-65_536); });
  }
  const [unpairExitCode] = await once(cli, "close", { signal: AbortSignal.timeout(12_000) });
  assert.equal(unpairExitCode, 0, `offline unpair failed: ${cliOutput}`);
  assert.match(cliOutput, /could not confirm revocation/);
  assert.equal(await deviceStore.loadDeviceCredential(), null);
  cli = undefined;
  console.log("unpair: built CLI cleared its isolated pairing with the relay offline");
}

try {
  await main();
  console.log("Local integration smoke passed.");
} finally {
  if (cli && cli.exitCode === null) {
    const closed = once(cli, "close");
    cli.kill();
    await closed;
  }
  relay?.kill();
  await devAuth?.close();
  await Promise.all(
    temporaryPaths.map(async (directory) =>
      await rm(directory, { recursive: true, force: true })),
  );
}
