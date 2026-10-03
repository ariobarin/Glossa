import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { applyHudEvent, initialHudState, type HudState } from "./ui-hud-model.js";

function add(state: HudState, requestId: string, shellCommand = "echo hello"): HudState {
  return applyHudEvent(state, {
    type: "activity", phase: "returned", ok: true,
    job: { type: "run_command", requestId, shellCommand, timeoutMs: 1_000 },
  });
}

test("repeated large calls bound rows and UTF-8 invocation bytes", () => {
  let state = initialHudState(".");
  for (let index = 0; index < 1_024; index += 1) {
    state = add(state, `request-${index}`, `echo ${index} ${"😀".repeat(15_000)}`);
    const bytes = state.activities.reduce((sum, row) =>
      sum + (row.call ? Buffer.byteLength(JSON.stringify(row.call), "utf8") : 0), 0);
    assert.ok(bytes <= 1024 * 1024, `Retained ${bytes} invocation bytes`);
  }
  assert.equal(state.activities.length, 256);
  assert.equal(state.activities[0]!.callUnavailable, "expired");
  assert.ok(state.activities.at(-1)!.call);
});

test("repeated completed records do not duplicate rows or consume the detail budget again", () => {
  let state = add(initialHudState("."), "same", "echo " + "x".repeat(60_000));
  const snapshot = state;
  for (let index = 0; index < 500; index += 1) state = add(state, "same");
  assert.equal(state.activities.length, 1);
  assert.ok(state.activities[0]!.call);
  for (let index = 0; index < 17; index += 1) {
    state = add(state, `new-${index}`, "echo " + "x".repeat(60_000));
  }
  assert.equal(state.activities[0]!.callUnavailable, "expired");
  for (let index = 0; index < 500; index += 1) state = add(state, "same");
  assert.equal(state.activities.length, 18);
  assert.equal(state.activities[0]!.call, undefined);
  assert.ok(snapshot.activities[0]!.call, "Updating history mutated an earlier snapshot");
});

test("retained Activity heap plateaus through repeated row and output eviction", async () => {
  if (!global.gc) {
    const child = spawnSync(process.execPath, [
      "--expose-gc", "--import", "tsx",
      "--test-name-pattern=^retained Activity heap plateaus through repeated row and output eviction$",
      fileURLToPath(import.meta.url),
    ], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  let state = initialHudState(".");
  const fill = (start: number, count: number): void => {
    for (let index = start; index < start + count; index += 1) {
      state = applyHudEvent(state, { type: "activity", phase: "returned", ok: true,
        job: { type: "read_file", requestId: `row-${index}`, path: `note-${index}.txt` },
        output: { kind: "success", preview: Buffer.from(`${index} ${"x".repeat(500)}`).toString() } });
    }
  };
  const heap = async (): Promise<number> => {
    for (let pass = 0; pass < 3; pass += 1) {
      await setImmediate();
      global.gc!();
    }
    return process.memoryUsage().heapUsed;
  };
  fill(0, 512);
  const baseline = await heap();
  fill(512, 6_000);
  const growth = await heap() - baseline;
  assert.ok(growth < 2 * 1024 * 1024, `Row eviction retained ${growth} heap bytes`);
  assert.equal(state.activities.length, 256);
});

test("completion keeps expired details expired and preserves output and start time", () => {
  const job = { type: "run_command" as const, requestId: "running",
    shellCommand: "echo " + "x".repeat(60_000), timeoutMs: 1_000 };
  let state = applyHudEvent(initialHudState("."), { type: "activity", phase: "started", job });
  const startedAt = state.activities[0]!.startedAt;
  for (let index = 0; index < 300; index += 1) {
    state = add(state, `other-${index}`, "echo " + "x".repeat(60_000));
  }
  for (let index = 0; index < 10_002; index += 1) state = add(state, `small-${index}`);
  state = applyHudEvent(state, { type: "activity", phase: "returned", job, ok: false,
    output: { kind: "error", preview: "head\n… output truncated …\ntail", truncated: true } });
  const rows = state.activities.filter((row) => row.requestId === "running");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "failed");
  assert.equal(rows[0]!.startedAt, startedAt);
  assert.equal(rows[0]!.callUnavailable, "expired");
  assert.equal(rows[0]!.call, undefined);
  assert.equal(rows[0]!.output?.preview, "head\n… output truncated …\ntail");
  assert.equal(rows[0]!.output?.truncated, true);
});

test("row eviction clears selection, inspection and browse anchors", () => {
  let state = add(initialHudState("."), "selected");
  state = { ...state, view: "activity-detail", activitySelection: "selected",
    activityBrowseAnchor: "selected", activityDetailScroll: 100 };
  for (let index = 0; index < 10_002; index += 1) state = add(state, `new-${index}`);
  assert.equal(state.activitySelection, undefined);
  assert.equal(state.activityBrowseAnchor, undefined);
  assert.equal(state.view, "activity");
  assert.equal(state.activityDetailScroll, 0);
});

test("a returned event whose row was evicted has no invented start time", () => {
  let state = initialHudState(".");
  for (let index = 0; index < 257; index += 1) {
    state = applyHudEvent(state, { type: "activity", phase: "started",
      job: { type: "read_file", requestId: `running-${index}`, path: "note.txt" } });
  }
  state = applyHudEvent(state, { type: "activity", phase: "returned", ok: true,
    job: { type: "read_file", requestId: "running-0", path: "note.txt" },
    output: { kind: "success", preview: "read completed" } });
  const row = state.activities.find((row) => row.requestId === "running-0")!;
  assert.equal(row.state, "returned");
  assert.equal(row.startedAt, undefined);
  assert.equal(row.output?.preview, "read completed");
  assert.equal(state.activities.length, 256);
});
