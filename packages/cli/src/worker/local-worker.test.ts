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
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfKkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(root, "preview.png"), png);
  const worker = await LocalWorker.create(root, "read-only");
  context.after(async () => await worker.shutdown());

  const readResult = await worker.handle({
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000001",
    path: "note.txt",
  });
  assert.equal(readResult.ok, true);
  assert.equal((readResult.value as { content?: unknown }).content, "original");

  const imageResult = await worker.handle({
    type: "view_image",
    requestId: "00000000-0000-4000-8000-000000000044",
    path: "preview.png",
  });
  assert.equal(imageResult.ok, true);
  assert.deepEqual(imageResult.value, {
    data: png.toString("base64"),
    mimeType: "image/png",
    sha256: "35fe4b5574eb5f6e274585b202843c030a25bba888a52236d0cdd1ae7dfea7f9",
    bytes: png.byteLength,
  });

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

  const directoryResult = await worker.handle({
    type: "make_directory",
    requestId: "00000000-0000-4000-8000-000000000040",
    path: "nested",
  });
  assert.equal(directoryResult.ok, true);
  const moveResult = await worker.handle({
    type: "move_path",
    requestId: "00000000-0000-4000-8000-000000000041",
    source: "note.txt",
    destination: "nested/note.txt",
  });
  assert.equal(moveResult.ok, true);
  assert.equal(
    await readFile(path.join(root, "nested", "note.txt"), "utf8"),
    "workspace write",
  );
  const deleteResult = await worker.handle({
    type: "delete_path",
    requestId: "00000000-0000-4000-8000-000000000042",
    path: "nested",
    recursive: true,
  });
  assert.equal(deleteResult.ok, true);
  await assert.rejects(readFile(path.join(root, "nested", "note.txt"), "utf8"), {
    code: "ENOENT",
  });

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
  const value = commandResult.value as {
    commandId?: unknown;
    status?: unknown;
    stdout?: unknown;
  };
  assert.equal(value.status, "succeeded");
  assert.equal(value.stdout, "system-ok");
  assert.equal(typeof value.commandId, "string");

  const outputResult = await worker.handle({
    type: "read_command_output",
    requestId: "00000000-0000-4000-8000-000000000007",
    commandId: String(value.commandId),
    stream: "stdout",
    offset: 0,
    maxBytes: 64,
  });
  assert.equal(outputResult.ok, true);
  assert.deepEqual(outputResult.value, {
    commandId: value.commandId,
    stream: "stdout",
    status: "succeeded",
    offset: 0,
    content: "system-ok",
    retainedBytes: 9,
    totalBytes: 9,
    retentionTruncated: false,
    complete: true,
  });
});

test("blocks recognizable authentication data before it leaves the worker", async (context) => {
  const root = await temporaryDirectory(context);
  const key = "sk-proj-" + "A".repeat(32);
  await writeFile(path.join(root, "secret.txt"), `OPENAI_API_KEY=${key}`, "utf8");
  const worker = await LocalWorker.create(root, "system");
  context.after(async () => await worker.shutdown());

  await writeFile(path.join(root, key), "safe", "utf8");

  const restrictedPathResult = await worker.handle({
    type: "read_file",
    requestId: "00000000-0000-4000-8000-00000000000c",
    path: key,
  });
  assert.equal(restrictedPathResult.ok, false);
  assert.equal(restrictedPathResult.error?.code, "restricted_data_blocked");
  const restrictedImagePathResult = await worker.handle({
    type: "view_image",
    requestId: "00000000-0000-4000-8000-000000000045",
    path: key,
  });
  assert.equal(restrictedImagePathResult.ok, false);
  assert.equal(restrictedImagePathResult.error?.code, "restricted_data_blocked");

  const listResult = await worker.handle({
    type: "list_files",
    requestId: "00000000-0000-4000-8000-00000000000d",
    timeoutMs: 1_000,
  });
  assert.equal(listResult.ok, false);
  assert.equal(listResult.error?.code, "restricted_data_blocked");
  assert.doesNotMatch(JSON.stringify(listResult), new RegExp(key));

  const searchInputResult = await worker.handle({
    type: "search_text",
    requestId: "00000000-0000-4000-8000-00000000000e",
    query: key,
    timeoutMs: 1_000,
  });
  assert.equal(searchInputResult.ok, false);
  assert.equal(searchInputResult.error?.code, "restricted_data_blocked");

  const restrictedGlobResult = await worker.handle({
    type: "search_text",
    requestId: "00000000-0000-4000-8000-000000000043",
    query: "safe",
    includeGlobs: [key],
    timeoutMs: 1_000,
  });
  assert.equal(restrictedGlobResult.ok, false);
  assert.equal(restrictedGlobResult.error?.code, "restricted_data_blocked");
  assert.doesNotMatch(JSON.stringify(restrictedGlobResult), new RegExp(key));

  const readResult = await worker.handle({
    type: "read_file",
    requestId: "00000000-0000-4000-8000-000000000007",
    path: "secret.txt",
  });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.error?.code, "restricted_data_blocked");
  assert.doesNotMatch(JSON.stringify(readResult), new RegExp(key));

  const editResult = await worker.handle({
    type: "edit_file",
    requestId: "00000000-0000-4000-8000-000000000008",
    path: "secret.txt",
    edits: [{ oldText: "OPENAI_API_KEY", newText: "REMOVED_KEY" }],
  });
  assert.equal(editResult.ok, false);
  assert.equal(editResult.error?.code, "restricted_data_blocked");
  assert.equal(
    await readFile(path.join(root, "secret.txt"), "utf8"),
    `OPENAI_API_KEY=${key}`,
  );

  const writeResult = await worker.handle({
    type: "write_file",
    requestId: "00000000-0000-4000-8000-00000000000b",
    path: "copied-secret.txt",
    content: key,
  });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.error?.code, "restricted_data_blocked");
  await assert.rejects(readFile(path.join(root, "copied-secret.txt"), "utf8"));

  const commandResult = await worker.handle({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000009",
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write('sk-proj-'); setTimeout(() => process.stdout.write('A'.repeat(32)), 25); setInterval(() => {}, 1000)",
    ],
    timeoutMs: 5_000,
    waitMs: 5_000,
  });
  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.error?.code, "restricted_data_blocked");
  assert.doesNotMatch(JSON.stringify(commandResult), new RegExp(key));
});

test("allows explicit placeholders through the restricted-data guard", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "example.env"), "OPENAI_API_KEY=<redacted>\n", "utf8");
  const worker = await LocalWorker.create(root, "read-only");
  context.after(async () => await worker.shutdown());

  const result = await worker.handle({
    type: "read_file",
    requestId: "00000000-0000-4000-8000-00000000000a",
    path: "example.env",
  });
  assert.equal(result.ok, true);
  assert.equal(
    (result.value as { content?: unknown }).content,
    "OPENAI_API_KEY=<redacted>\n",
  );
});
