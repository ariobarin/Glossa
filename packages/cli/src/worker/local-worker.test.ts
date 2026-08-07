import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalWorker } from "./local-worker.js";

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-access-test-"));
  context.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  return directory;
}

test("enforces read-only access inside the local worker", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "note.txt"), "original", "utf8");
  const worker = await LocalWorker.create(root, "read-only");
  context.after(async () => await worker.shutdown());

  const readResult = await worker.handle({
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000001",
    path: "note.txt",
  });
  assert.equal(readResult.ok, true);
  assert.equal((readResult.value as { content?: unknown }).content, "original");

  const writeResult = await worker.handle({
    type: "write_file",
    requestId: "00000000-0000-4000-8000-000000000002",
    path: "note.txt",
    content: "changed",
  });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.error?.code, "write_access_disabled");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "original");

  const commandResult = await worker.handle({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000003",
    argv: [process.execPath, "--version"],
    timeoutMs: 5_000,
  });
  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.error?.code, "command_access_disabled");
});

test("workspace access permits guarded file writes but not commands", async (context) => {
  const root = await temporaryDirectory(context);
  const worker = await LocalWorker.create(root, "workspace");
  context.after(async () => await worker.shutdown());

  const writeResult = await worker.handle({
    type: "write_file",
    requestId: "00000000-0000-4000-8000-000000000004",
    path: "note.txt",
    content: "workspace write",
  });
  assert.equal(writeResult.ok, true);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "workspace write");

  const commandResult = await worker.handle({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000005",
    argv: [process.execPath, "--version"],
    timeoutMs: 5_000,
  });
  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.error?.code, "command_access_disabled");
});

test("system access preserves full local command execution", async (context) => {
  const root = await temporaryDirectory(context);
  const worker = await LocalWorker.create(root, "system");
  context.after(async () => await worker.shutdown());

  const commandResult = await worker.handle({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000006",
    argv: [process.execPath, "-e", "process.stdout.write('system-ok')"],
    timeoutMs: 5_000,
    waitMs: 5_000,
  });
  assert.equal(commandResult.ok, true);
  const value = commandResult.value as { status?: unknown; stdout?: unknown };
  assert.equal(value.status, "succeeded");
  assert.equal(value.stdout, "system-ok");
});
