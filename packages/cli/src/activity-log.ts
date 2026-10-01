import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { configDirectory } from "./secure-store.js";
import {
  applyHudEvent,
  initialHudState,
  type HudActivity,
  type HudActivityHistory,
} from "./ui-hud-model.js";
import type { ManagedSessionEvent } from "./worker/managed-session.js";

type ActivityEvent = Extract<ManagedSessionEvent, { type: "activity" }>;
const INDEX_ENTRY_BYTES = 16;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;

function writeAll(fd: number, data: Buffer, position: number): void {
  let written = 0;
  while (written < data.length) {
    const count = writeSync(fd, data, written, data.length - written, position + written);
    if (count === 0) throw new Error("Activity log write made no progress.");
    written += count;
  }
}

function readAll(fd: number, data: Buffer, position: number): void {
  let read = 0;
  while (read < data.length) {
    const count = readSync(fd, data, read, data.length - read, position + read);
    if (count === 0) throw new Error("Activity log is incomplete.");
    read += count;
  }
}

/** Local JSONL journal with a disk index; memory does not grow with history. */
export class ActivityLog {
  readonly file: string;
  #journal: number;
  #index: number;
  #length = 0;
  #offset = 0;
  #closed = false;
  // Only in-flight requests live here (the worker admits at most five).
  #working = new Map<string, number>();
  #cache = new Map<number, { activity: HudActivity; bytes: number }>();
  #cacheBytes = 0;

  constructor(directory: string = path.join(configDirectory(), "logs")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID();
    this.file = path.join(directory, name + ".jsonl");
    this.#journal = openSync(this.file, "wx+", 0o600);
    try {
      this.#index = openSync(path.join(directory, name + ".idx"), "wx+", 0o600);
    } catch (error) {
      closeSync(this.#journal);
      throw error;
    }
  }

  append(event: ActivityEvent): HudActivityHistory {
    this.#assertOpen();
    const existingIndex = this.#working.get(event.job.requestId);
    const existing = existingIndex === undefined ? undefined : this.#at(existingIndex);
    const activity = applyHudEvent({
      ...initialHudState(""),
      activities: existing ? [existing] : [],
    }, event).activities[0]!;
    let serialized = Buffer.from(JSON.stringify(activity) + "\n");
    if (serialized.length > MAX_RECORD_BYTES) {
      const { call: _call, callBytes: _callBytes, ...compact } = activity;
      // Also bound summaries derived from lists of arguments or extensions.
      compact.summary = {
        ...compact.summary,
        details: compact.summary.details.slice(0, 16).map((detail) =>
          Buffer.from(detail.slice(0, 512)).toString()),
      };
      serialized = Buffer.from(JSON.stringify({ ...compact, callUnavailable: "oversized" }) + "\n");
    }
    if (serialized.length > MAX_RECORD_BYTES) throw new Error("Activity log record is too large.");

    const index = existingIndex ?? this.#length;
    writeAll(this.#journal, serialized, this.#offset);
    const entry = Buffer.alloc(INDEX_ENTRY_BYTES);
    entry.writeBigUInt64LE(BigInt(this.#offset), 0);
    entry.writeBigUInt64LE(BigInt(serialized.length), 8);
    writeAll(this.#index, entry, index * INDEX_ENTRY_BYTES);
    this.#offset += serialized.length;
    if (existingIndex === undefined) this.#length += 1;
    this.#evict(index);
    if (event.phase === "started") this.#working.set(event.job.requestId, index);
    else this.#working.delete(event.job.requestId);
    return this.snapshot();
  }

  snapshot(): HudActivityHistory {
    const length = this.#length;
    return {
      length,
      hasWorking: this.#working.size > 0,
      at: (index) => index >= 0 && index < length ? this.#at(index) : undefined,
      slice: (start, end) => {
        const normalize = (value: number): number => Math.max(0, Math.min(length, value < 0 ? length + value : value));
        const activities: HudActivity[] = [];
        for (let index = normalize(start); index < normalize(end); index += 1) {
          activities.push(this.#at(index));
        }
        return activities;
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#working.clear();
    this.#cache.clear();
    this.#cacheBytes = 0;
    try { closeSync(this.#journal); } finally { closeSync(this.#index); }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Activity log is closed.");
  }

  #evict(index: number): void {
    const cached = this.#cache.get(index);
    if (!cached) return;
    this.#cacheBytes -= cached.bytes;
    this.#cache.delete(index);
  }

  #at(index: number): HudActivity {
    this.#assertOpen();
    const cached = this.#cache.get(index);
    if (cached) {
      this.#cache.delete(index);
      this.#cache.set(index, cached);
      return cached.activity;
    }
    const entry = Buffer.alloc(INDEX_ENTRY_BYTES);
    readAll(this.#index, entry, index * INDEX_ENTRY_BYTES);
    const offset = Number(entry.readBigUInt64LE(0));
    const length = Number(entry.readBigUInt64LE(8));
    if (!Number.isSafeInteger(offset) || length < 1 || length > MAX_RECORD_BYTES) {
      throw new Error("Activity log index is invalid.");
    }
    const record = Buffer.alloc(length);
    readAll(this.#journal, record, offset);
    const activity = JSON.parse(record.toString("utf8")) as HudActivity;
    // Account for UTF-16 strings as well as serialized bytes.
    const bytes = length * 2;
    while (this.#cache.size >= MAX_CACHE_ENTRIES || this.#cacheBytes + bytes > MAX_CACHE_BYTES) {
      this.#evict(this.#cache.keys().next().value!);
    }
    this.#cache.set(index, { activity, bytes });
    this.#cacheBytes += bytes;
    return activity;
  }
}
