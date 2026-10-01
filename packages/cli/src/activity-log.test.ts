import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { activityEventJobFromJob } from "./activity-call.js";
import { ActivityLog } from "./activity-log.js";
import { activityCount, activitySlice, initialHudState } from "./ui-hud-model.js";
import { renderHud } from "./ui-hud.js";

function logForTest(context: TestContext): ActivityLog {
  const directory = mkdtempSync(path.join(os.tmpdir(), "glossa-activity-log-"));
  const log = new ActivityLog(directory);
  context.after(() => { log.close(); rmSync(directory, { recursive: true, force: true }); });
  return log;
}

test("logs update an in-flight row after cache eviction and retain old details beyond 9,999 rows", (context) => {
  const log = logForTest(context);
  const job = { type: "read_file" as const, requestId: "old-request", path: "old.txt" };
  const started = log.append({ type: "activity", phase: "started", job }).at(0)!;
  for (let index = 0; index < 10_002; index += 1) {
    const history = log.append({ type: "activity", phase: "returned", ok: true,
      job: { type: "read_file", requestId: "request-" + index, path: "file-" + index + ".txt" } });
    history.at(index + 1);
  }
  const history = log.append({ type: "activity", phase: "returned", ok: false, job,
    output: { kind: "error", preview: "Missing file." } });
  assert.equal(history.length, 10_003);
  assert.equal(history.hasWorking, false);
  assert.equal(history.at(0)!.state, "failed");
  assert.equal(history.at(0)!.startedAt, started.startedAt);
  assert.deepEqual(history.at(0)!.call, { type: "read_file", path: "old.txt" });
  assert.equal(history.at(0)!.output!.preview, "Missing file.");
  assert.equal(history.slice(-2, history.length)[0]!.requestId, "request-10000");
  assert.equal(history.at(-1), undefined);
  const records = readFileSync(log.file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 10_004);
  assert.equal(records.at(-1).state, "failed");
  assert.equal(statSync(log.file.replace(/\.jsonl$/, ".idx")).size, history.length * 16);
  log.close();
  assert.ok(statSync(log.file).size > 0);
  assert.throws(() => history.at(0), /closed/);
});

test("disk history renders old pages and selected details without an in-memory activity array", (context) => {
  const log = logForTest(context);
  for (let index = 0; index < 100; index += 1) {
    log.append({ type: "activity", phase: "returned", ok: true,
      job: { type: "read_file", requestId: "request-" + index, path: "file-" + index + ".txt" } });
  }
  const state = { ...initialHudState("."), activityHistory: log.snapshot(), view: "activity" as const,
    activityBrowseEnd: 20, activitySelection: "request-15", activitySelectionIndex: 15 };
  assert.deepEqual(state.activities, []);
  assert.equal(activityCount(state), 100);
  assert.equal(activitySlice(state, 0, 2).length, 2);
  const list = renderHud(state, 100, false, 20);
  assert.match(list, /file-15.txt/);
  assert.doesNotMatch(list, /file-99.txt/);
  assert.match(list, /\/100\)/);
  const detail = renderHud({ ...state, view: "activity-detail" }, 100, false, 20);
  assert.match(detail, /path\s+"file-15.txt"/);
});

test("journals use private files and exclude raw file, edit and stdin bodies and restricted inputs", (context) => {
  const log = logForTest(context);
  const jobs = [
    { type: "write_file" as const, requestId: "write", path: "note.txt", content: "private-write-body" },
    { type: "edit_file" as const, requestId: "edit", path: "note.txt",
      edits: [{ oldText: "private-old-text", newText: "private-new-text" }] },
    { type: "run_command" as const, requestId: "stdin", argv: ["node"], stdin: "private-stdin-body", timeoutMs: 1000 },
    { type: "run_command" as const, requestId: "restricted", shellCommand: "echo sk-proj-" + "a".repeat(64), timeoutMs: 1000 },
  ];
  for (const job of jobs) {
    log.append({ type: "activity", phase: "returned", ok: true, job: activityEventJobFromJob(job) });
  }
  const journal = readFileSync(log.file, "utf8");
  assert.doesNotMatch(journal, /private-write-body|private-old-text|private-new-text|private-stdin-body/);
  assert.doesNotMatch(journal, new RegExp("sk-proj-" + "a".repeat(64)));
  assert.match(journal, /restricted input blocked/);
  if (process.platform !== "win32") assert.equal(statSync(log.file).mode & 0o777, 0o600);
});

test("oversized calls keep compact rows and every serialized record fits the disk budget", (context) => {
  const log = logForTest(context);
  const history = log.append({ type: "activity", phase: "returned", ok: true,
    job: { type: "run_command", requestId: "large", shellCommand: "echo " + "x".repeat(100_000), timeoutMs: 1000 } });
  assert.equal(history.at(0)!.callUnavailable, "oversized");
  assert.equal(history.at(0)!.call, undefined);
  assert.ok(history.at(0)!.compactSummary!.length <= 512);
  assert.ok(statSync(log.file).size <= 64 * 1024);
});

test("file-backed Activity memory stays constant as the journal grows", async (context) => {
  if (!global.gc) {
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx",
      "--test-name-pattern=^file-backed Activity memory stays constant as the journal grows$",
      fileURLToPath(import.meta.url)], { encoding: "utf8", timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const log = logForTest(context);
  const retainedHeap = async (): Promise<number> => {
    for (let pass = 0; pass < 3; pass += 1) { await setImmediate(); global.gc!(); }
    return process.memoryUsage().heapUsed;
  };
  const add = (start: number, count: number): void => {
    for (let index = start; index < start + count; index += 1) {
      const history = log.append({ type: "activity", phase: "returned", ok: true,
        job: { type: "run_command", requestId: "request-" + index,
          shellCommand: Buffer.from("echo " + index + " " + "x".repeat(8000)).toString(), timeoutMs: 1000 } });
      history.at(index);
    }
  };
  add(0, 1000);
  const baseline = await retainedHeap();
  add(1000, 10_000);
  const growth = await retainedHeap() - baseline;
  assert.ok(growth < 2 * 1024 * 1024, "Journal growth retained " + growth + " heap bytes.");
  assert.ok(statSync(log.file).size > 80 * 1024 * 1024);
});
