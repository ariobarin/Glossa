// Full local integration smoke: mock issuer + local relay + real CLI pairing,
// device-credential management, and an MCP read_file roundtrip through a live
// worker. Runs entirely against local processes; no production tenant or
// relay is touched. Requires npm run build and local Postgres.
import "./fixtures/isolated-cli.mjs";
import { once } from "node:events";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startDevAuth, type DevAuthServer } from "./dev-auth.js";
import { createResourceFiles } from "./fixtures/resource-files.js";
import {
  MAX_COMMAND_OUTPUT_BYTES, MAX_COMMAND_RETAINED_STREAM_BYTES, MAX_TEXT_BYTES,
} from "@glossa/protocol";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl = process.env.GLOSSA_INTEGRATION_DATABASE_URL ??
  "postgres://glossa:glossa@localhost:55432/glossa";
const relayOrigin = process.env.GLOSSA_INTEGRATION_RELAY_ORIGIN ??
  "http://127.0.0.1:39100";
const audience = `${relayOrigin}/`;
const relayPort = new URL(relayOrigin).port || "80";
for (const endpoint of [relayOrigin, databaseUrl]) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname),
    "Integration endpoints must be loopback fixtures");
}

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

async function issueToken(scope: string, subject = "dev|local-user"): Promise<string> {
  const response = await fetch(`${devAuth!.issuer}oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      sub: subject,
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
    ["apps/relay/dist/src/index.js"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        GLOSSA_BIND_HOST: "127.0.0.1",
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
  assert.equal((await fetch(`${relayOrigin}/mcp`)).status, 401);
  assert.equal((await fetch(`${relayOrigin}/mcp`, {
    headers: { authorization: `Bearer ${await issueToken("glossa:device")}` },
  })).status, 403);
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
  const fixtureRoot = await temporaryDirectory("glossa-smoke-workspace-");
  const workspace = path.join(fixtureRoot, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(fixtureRoot, "outside.txt"), "outside sentinel");
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
    return result.structuredContent as Record<string, unknown>;
  };
  const expectError = async (name: string, args: Record<string, unknown>, code: string) => {
    const result = await mcp.callTool({
      name, arguments: { workspaceId: workspaces[0]!.workspaceId, ...args },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), new RegExp(code));
  };
  const stranger = new Client({ name: "glossa-other-account", version: "0.0.0" });
  try {
    await stranger.connect(new StreamableHTTPClientTransport(new URL(`${relayOrigin}/mcp`), {
      requestInit: { headers: {
        authorization: `Bearer ${await issueToken("glossa:access", "dev|other-user")}`,
      } },
    }));
    const hidden = await stranger.callTool({ name: "list_workspaces", arguments: {} });
    assert.deepEqual((hidden.structuredContent as { workspaces: unknown[] }).workspaces, []);
    for (const [name, args] of [
      ["read_file", { path: "hello.txt" }],
      ["write_file", { path: "hello.txt", content: "cross-account overwrite" }],
    ] as const) {
      const denied = await stranger.callTool({
        name, arguments: { workspaceId: workspaces[0]!.workspaceId, ...args },
      });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.content), /device_offline/);
      assert.doesNotMatch(JSON.stringify(denied.content), /local integration works/);
    }
  } finally {
    await stranger.close();
  }
  assert.equal(await readFile(path.join(workspace, "hello.txt"), "utf8"),
    "local integration works\n");
  await expectError("read_file", { path: "../outside.txt" }, "path_traversal");
  await expectError("read_file", { path: path.join(fixtureRoot, "outside.txt") }, "absolute_path");

  await createResourceFiles(workspace);
  assert.equal((await callWorkerTool("read_file", { path: "limit.txt" })).bytes,
    MAX_TEXT_BYTES);
  const limitedRange = await callWorkerTool("read_file_range", {
    path: "limit.txt", startLine: 1, lineCount: 64,
  });
  assert.equal(limitedRange.contentBytes, 65_535);
  assert.equal(limitedRange.nextLine, 65);
  const longRange = await callWorkerTool("read_file_range", {
    path: "long-limit.txt", startLine: 1, lineCount: 2,
  });
  assert.equal(longRange.contentBytes, 65_536);
  assert.equal(longRange.nextLine, 2);
  await expectError("read_file", { path: "over.txt" }, "file_too_large");
  await expectError("read_file_range", { path: "long-over.txt" }, "line_too_large");
  console.log("mcp: OAuth scope, account ownership and exact/over text and range limits passed");
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
  await expectError("edit_file", {
    path: "roundtrip/note.txt", expectedSha256: revision.sha256,
    edits: [{ oldText: "updated", newText: "must not write" }],
  }, "stale_revision");
  await expectError("write_file", {
    path: "roundtrip/note.txt", expectedSha256: revision.sha256, content: "must not write",
  }, "stale_revision");
  assert.equal(await readFile(path.join(workspace, "roundtrip/note.txt"), "utf8"),
    "first\nupdated\n");
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

  const image = CallToolResultSchema.parse(await mcp.callTool({
    name: "view_image",
    arguments: { workspaceId: workspaces[0]!.workspaceId, path: "pixel.png" },
  }));
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

  const outputBytes = MAX_COMMAND_RETAINED_STREAM_BYTES + 65_536;
  const noisy = await callWorkerTool("run_command", {
    command: { argv: [process.execPath, "-e",
      `process.stdout.write('x'.repeat(${outputBytes})); process.stderr.write('y'.repeat(${outputBytes}))`] },
    waitMs: 5_000,
  }, systemId);
  const noisyDone = await callWorkerTool("get_command", {
    commandId: noisy.commandId, waitMs: 15_000,
  }, systemId);
  assert.equal(noisyDone.status, "succeeded");
  assert.equal(noisyDone.stdoutTruncated, true);
  assert.equal(noisyDone.stderrTruncated, true);
  assert.ok(Buffer.byteLength(String(noisyDone.stdout) + String(noisyDone.stderr))
    <= MAX_COMMAND_OUTPUT_BYTES);
  for (const stream of ["stdout", "stderr"]) {
    const retained = await callWorkerTool("read_command_output", {
      commandId: noisy.commandId, stream, offset: 0, maxBytes: 65_536,
    }, systemId);
    assert.equal(retained.retainedBytes, MAX_COMMAND_RETAINED_STREAM_BYTES);
    assert.equal(retained.totalBytes, outputBytes);
    assert.equal(retained.retentionTruncated, true);
    assert.equal(Buffer.byteLength(retained.content as string), 65_536);
    assert.equal(retained.nextOffset, 65_536);
  }
  console.log("mcp: dual-stream truncation and retained-output byte caps passed");

  const expiring = await callWorkerTool("run_command", {
    command: { argv: [process.execPath, "-e",
      "console.log(JSON.stringify({pid:process.pid})); setTimeout(() => {}, 30000)"] },
    timeoutMs: 500, waitMs: 0,
  }, systemId);
  const timeoutStarted = performance.now();
  const timedOut = await callWorkerTool("get_command", {
    commandId: expiring.commandId, waitMs: 15_000,
  }, systemId);
  assert.equal(timedOut.status, "timed_out");
  assert.ok(performance.now() - timeoutStarted < 5_000, "command timeout did not release its process");
  const expiredPid = (JSON.parse(timedOut.stdout as string) as { pid: number }).pid;
  assert.throws(() => process.kill(expiredPid, 0), { code: "ESRCH" });
  console.log("mcp: command timeout terminated its child process promptly");

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
