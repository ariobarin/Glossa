import type { WorkerJob } from "@glossa/protocol";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { configDirectory } from "./secure-store.js";

export type UsageEvent =
  | { v: 1; at: string; kind: "session" }
  | { v: 1; at: string; kind: "tool"; tool: WorkerJob["type"]; ok: boolean };

export interface UsageBucket {
  sessions: number;
  successfulToolUses: number;
  failedToolUses: number;
}

export interface UsageSummary extends UsageBucket {
  lifetimeToolUses: number;
  byDay: Record<string, UsageBucket>;
  byHour: Record<string, UsageBucket>;
}

function emptyBucket(): UsageBucket {
  return { sessions: 0, successfulToolUses: 0, failedToolUses: 0 };
}

export function usageFile(): string {
  return path.join(configDirectory(), "usage.jsonl");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseUsageEvent(line: string): UsageEvent | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.v !== 1 || !validTimestamp(value.at)) return undefined;
    if (value.kind === "session") {
      return { v: 1, at: value.at, kind: "session" };
    }
    if (
      value.kind === "tool" &&
      typeof value.tool === "string" &&
      typeof value.ok === "boolean"
    ) {
      return {
        v: 1,
        at: value.at,
        kind: "tool",
        tool: value.tool as WorkerJob["type"],
        ok: value.ok,
      };
    }
  } catch {
    // Ignore malformed or partially written lines. The log is append-only so a
    // crash cannot invalidate earlier usage history.
  }
  return undefined;
}

export async function recordUsageEvent(
  event: UsageEvent,
  file = usageFile(),
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(file, 0o600);
}

export async function recordSessionUsage(
  at = new Date(),
  file = usageFile(),
): Promise<void> {
  await recordUsageEvent({ v: 1, at: at.toISOString(), kind: "session" }, file);
}

export async function recordToolUsage(
  tool: WorkerJob["type"],
  ok: boolean,
  at = new Date(),
  file = usageFile(),
): Promise<void> {
  await recordUsageEvent({ v: 1, at: at.toISOString(), kind: "tool", tool, ok }, file);
}

function incrementBucket(bucket: UsageBucket, event: UsageEvent): void {
  if (event.kind === "session") {
    bucket.sessions += 1;
  } else if (event.ok) {
    bucket.successfulToolUses += 1;
  } else {
    bucket.failedToolUses += 1;
  }
}

export async function loadUsageSummary(file = usageFile()): Promise<UsageSummary> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ...emptyBucket(),
        lifetimeToolUses: 0,
        byDay: {},
        byHour: {},
      };
    }
    throw error;
  }

  const summary: UsageSummary = {
    ...emptyBucket(),
    lifetimeToolUses: 0,
    byDay: {},
    byHour: {},
  };
  for (const line of content.split("\n")) {
    if (!line) continue;
    const event = parseUsageEvent(line);
    if (!event) continue;
    incrementBucket(summary, event);
    if (event.kind === "tool") summary.lifetimeToolUses += 1;

    const day = event.at.slice(0, 10);
    const hour = `${event.at.slice(0, 13)}:00`;
    const dayBucket = summary.byDay[day] ??= emptyBucket();
    const hourBucket = summary.byHour[hour] ??= emptyBucket();
    incrementBucket(dayBucket, event);
    incrementBucket(hourBucket, event);
  }
  return summary;
}
