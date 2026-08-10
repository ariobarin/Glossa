import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadUsageSummary,
  recordSessionUsage,
  recordToolUsage,
} from "./usage-store.js";

async function temporaryUsageFile(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-usage-"));
  return { directory, file: path.join(directory, "usage.jsonl") };
}

test("usage tracking preserves lifetime and hourly/day buckets", async () => {
  const { directory, file } = await temporaryUsageFile();
  try {
    await recordSessionUsage(new Date("2026-08-10T10:00:00.000Z"), file);
    await recordToolUsage("read_file", true, new Date("2026-08-10T10:05:00.000Z"), file);
    await recordToolUsage("search_text", false, new Date("2026-08-10T11:05:00.000Z"), file);
    await recordToolUsage("run_command", true, new Date("2026-08-11T01:00:00.000Z"), file);

    const summary = await loadUsageSummary(file);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.lifetimeToolUses, 3);
    assert.equal(summary.successfulToolUses, 2);
    assert.equal(summary.failedToolUses, 1);
    assert.deepEqual(summary.byDay["2026-08-10"], {
      sessions: 1,
      successfulToolUses: 1,
      failedToolUses: 1,
    });
    assert.deepEqual(summary.byHour["2026-08-10T10:00"], {
      sessions: 1,
      successfulToolUses: 1,
      failedToolUses: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage tracking tolerates malformed trailing data", async () => {
  const { directory, file } = await temporaryUsageFile();
  try {
    await recordToolUsage("read_file", true, new Date("2026-08-10T10:00:00.000Z"), file);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}{"v":1,"kind":"tool"`,
      "utf8",
    );
    const summary = await loadUsageSummary(file);
    assert.equal(summary.lifetimeToolUses, 1);
    assert.equal(summary.successfulToolUses, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent usage appends do not lose tool uses", async () => {
  const { directory, file } = await temporaryUsageFile();
  try {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        recordToolUsage(
          index % 2 === 0 ? "read_file" : "search_text",
          true,
          new Date(`2026-08-10T10:${String(index).padStart(2, "0")}:00.000Z`),
          file,
        )
      ),
    );
    const summary = await loadUsageSummary(file);
    assert.equal(summary.lifetimeToolUses, 50);
    assert.equal(summary.successfulToolUses, 50);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
