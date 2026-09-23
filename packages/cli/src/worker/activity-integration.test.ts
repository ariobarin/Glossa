import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkerJob } from "@glossa/protocol";
import type { ActivityEventJob } from "../activity-call.js";
import { LocalWorker } from "./local-worker.js";
import { visibleWorker, type ManagedSessionEvent } from "./managed-session.js";

test("real worker activity carries counts instead of file, edit, and stdin bodies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-activity-integration-"));
  const local = await LocalWorker.create(root, "system");
  const events: Extract<ManagedSessionEvent, { type: "activity" }>[] = [];
  const worker = visibleWorker(local, {
    quiet: true,
    onEvent: (event) => { if (event.type === "activity") events.push(event); },
  });
  async function run(job: WorkerJob, expected: ActivityEventJob) {
    events.length = 0;
    const result = await worker.handle(job);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(events.map((event) => event.phase), ["started", "returned"]);
    assert.deepEqual(events.map((event) => event.job), [expected, expected]);
    return result;
  }
  try {
    const content = "private file body é";
    const replacement = "private replacement body";
    const requestId = "00000000-0000-4000-8000-000000000070";
    const written = await run({ type: "write_file", requestId, path: "note.txt", content }, {
      type: "write_file", requestId, path: "note.txt", contentBytes: Buffer.byteLength(content),
    });
    const expectedSha256 = (written.value as { sha256: string }).sha256;
    await run({
      type: "edit_file", requestId, path: "note.txt", expectedSha256,
      edits: [{ oldText: content, newText: replacement }],
    }, {
      type: "edit_file", requestId, path: "note.txt", expectedSha256,
      editCount: 1, editBytes: Buffer.byteLength(content) + Buffer.byteLength(replacement),
    });
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), replacement);
    const stdin = "private stdin body";
    const argv = [process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('stdin-consumed'))"];
    const command = await run({ type: "run_command", requestId, argv, stdin, timeoutMs: 10_000, waitMs: 5_000 }, {
      type: "run_command", requestId, argv, stdinBytes: Buffer.byteLength(stdin), timeoutMs: 10_000, waitMs: 5_000,
    });
    assert.match(JSON.stringify(command.value), /stdin-consumed/);
  } finally {
    await local.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
