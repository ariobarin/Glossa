import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_FAST_WAIT_MS,
  MAX_COMMAND_STATUS_WAIT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "@glossa/protocol";
import { WorkerError } from "./errors.js";
import type { PathPolicy } from "./path-policy.js";

export type CommandStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export interface StartCommandOptions {
  argv?: string[];
  shellCommand?: string;
  stdin?: string;
  timeoutMs?: number;
  waitMs?: number;
}

export interface CommandSnapshot {
  commandId: string;
  status: CommandStatus;
  sequence: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

interface CapturedStream {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

interface CommandRecord {
  id: string;
  child: ChildProcessWithoutNullStreams;
  status: CommandStatus;
  sequence: number;
  changeWaiters: Set<() => void>;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: CapturedStream;
  stderr: CapturedStream;
  completion: Promise<void>;
  complete: () => void;
  requestedTerminal?: "canceled" | "timed_out";
  timeout?: NodeJS.Timeout;
}

function capture(record: CommandRecord, stream: CapturedStream, chunk: Buffer): boolean {
  const capturedBytes = record.stdout.bytes + record.stderr.bytes;
  if (capturedBytes >= MAX_COMMAND_OUTPUT_BYTES) {
    if (stream.truncated) return false;
    stream.truncated = true;
    return true;
  }
  const remaining = MAX_COMMAND_OUTPUT_BYTES - capturedBytes;
  const accepted = chunk.subarray(0, remaining);
  if (accepted.byteLength > 0) {
    stream.chunks.push(accepted);
    stream.bytes += accepted.byteLength;
  }
  const newlyTruncated = accepted.byteLength < chunk.byteLength && !stream.truncated;
  if (newlyTruncated) stream.truncated = true;
  return accepted.byteLength > 0 || newlyTruncated;
}

function markChanged(record: CommandRecord): void {
  record.sequence += 1;
  const waiters = [...record.changeWaiters];
  record.changeWaiters.clear();
  for (const waiter of waiters) waiter();
}

async function waitForChange(
  record: CommandRecord,
  afterSequence: number,
  waitMs: number,
): Promise<void> {
  if (record.status !== "running" || record.sequence > afterSequence || waitMs === 0) {
    return;
  }
  let changed!: () => void;
  const change = new Promise<void>((resolve) => {
    changed = resolve;
    record.changeWaiters.add(changed);
  });
  const waitController = new AbortController();
  try {
    await Promise.race([
      change,
      delay(waitMs, undefined, { signal: waitController.signal }),
    ]);
  } finally {
    record.changeWaiters.delete(changed);
    waitController.abort();
  }
}

function emptyCapture(): CapturedStream {
  return { chunks: [], bytes: 0, truncated: false };
}

function decodeCapture(stream: CapturedStream, complete: boolean): string {
  const content = Buffer.concat(stream.chunks);
  return complete && !stream.truncated
    ? content.toString("utf8")
    : new StringDecoder("utf8").write(content);
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = process.env.GLOSSA_WINDOWS_SHELL ?? "powershell.exe";
    return {
      file,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { file: process.env.SHELL ?? "/bin/sh", args: ["-lc", command] };
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await delay(2_000);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export class CommandService {
  readonly #commands = new Map<string, CommandRecord>();
  #activeCommandId: string | null = null;

  constructor(readonly policy: PathPolicy) {}

  async start(options: StartCommandOptions): Promise<CommandSnapshot> {
    if (this.#activeCommandId) {
      const active = this.#commands.get(this.#activeCommandId);
      if (active?.status === "running") {
        throw new WorkerError("command_busy", "Only one command may run per worker.");
      }
      this.#activeCommandId = null;
    }
    if ((options.argv ? 1 : 0) + (options.shellCommand ? 1 : 0) !== 1) {
      throw new WorkerError(
        "invalid_command",
        "Exactly one of argv or shellCommand is required.",
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      throw new WorkerError(
        "invalid_timeout",
        "Command timeout must be between 1 millisecond and 60 minutes.",
      );
    }
    const waitMs = options.waitMs ?? DEFAULT_COMMAND_FAST_WAIT_MS;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_COMMAND_FAST_WAIT_MS) {
      throw new WorkerError(
        "invalid_wait",
        "Command start wait must be between 0 and 5 seconds.",
      );
    }
    const cwd = this.policy.root;
    const invocation = options.argv
      ? { file: options.argv[0]!, args: options.argv.slice(1) }
      : shellInvocation(options.shellCommand!);

    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: "pipe",
      windowsHide: true,
    });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const id = randomUUID();
    const record: CommandRecord = {
      id,
      child,
      status: "running",
      sequence: 0,
      changeWaiters: new Set(),
      startedAt: Date.now(),
      stdout: emptyCapture(),
      stderr: emptyCapture(),
      completion,
      complete,
    };
    record.timeout = setTimeout(() => {
      if (record.status !== "running") return;
      record.requestedTerminal = "timed_out";
      void terminateProcessTree(child);
    }, timeoutMs);
    record.timeout.unref();
    this.#commands.set(id, record);
    this.#activeCommandId = id;

    child.stdout.on("data", (chunk: Buffer) => {
      if (capture(record, record.stdout, chunk)) markChanged(record);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (capture(record, record.stderr, chunk)) markChanged(record);
    });
    child.once("error", (error) => {
      if (record.status !== "running") return;
      if (record.timeout) clearTimeout(record.timeout);
      record.status = "failed";
      record.finishedAt = Date.now();
      capture(record, record.stderr, Buffer.from(error.message, "utf8"));
      this.#activeCommandId = null;
      markChanged(record);
      record.complete();
    });
    child.once("close", (exitCode, signal) => {
      if (record.status !== "running") return;
      if (record.timeout) clearTimeout(record.timeout);
      record.finishedAt = Date.now();
      record.exitCode = exitCode;
      record.signal = signal;
      record.status = record.requestedTerminal ?? (exitCode === 0 ? "succeeded" : "failed");
      this.#activeCommandId = null;
      markChanged(record);
      record.complete();
      setTimeout(() => this.#commands.delete(id), 5 * 60 * 1000).unref();
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error: unknown) => {
      await record.completion;
      throw new WorkerError(
        "command_spawn_failed",
        error instanceof Error ? error.message : "Command failed to start.",
      );
    });
    if (record.status === "running" && waitMs > 0) {
      const waitController = new AbortController();
      try {
        await Promise.race([
          record.completion,
          delay(waitMs, undefined, { signal: waitController.signal }),
        ]);
      } finally {
        waitController.abort();
      }
    }
    return this.snapshot(record);
  }

  async get(
    commandId: string,
    waitMs = 0,
    afterSequence?: number,
  ): Promise<CommandSnapshot> {
    const record = this.#commands.get(commandId);
    if (!record) throw new WorkerError("command_not_found", "The command was not found.");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_COMMAND_STATUS_WAIT_MS) {
      throw new WorkerError("invalid_wait", "Status wait must be between 0 and 15 seconds.");
    }
    if (
      afterSequence !== undefined &&
      (!Number.isInteger(afterSequence) ||
        afterSequence < 0 ||
        afterSequence > record.sequence)
    ) {
      throw new WorkerError(
        "invalid_sequence",
        "The command sequence is invalid for this command.",
      );
    }
    if (record.status === "running" && waitMs > 0) {
      if (afterSequence === undefined) {
        const waitController = new AbortController();
        try {
          await Promise.race([
            record.completion,
            delay(waitMs, undefined, { signal: waitController.signal }),
          ]);
        } finally {
          waitController.abort();
        }
      } else {
        await waitForChange(record, afterSequence, waitMs);
      }
    }
    return this.snapshot(record);
  }

  async cancel(commandId: string): Promise<CommandSnapshot> {
    const record = this.#commands.get(commandId);
    if (!record) throw new WorkerError("command_not_found", "The command was not found.");
    if (record.status !== "running") return this.snapshot(record);
    record.requestedTerminal = "canceled";
    await terminateProcessTree(record.child);
    await record.completion;
    return this.snapshot(record);
  }

  async shutdown(): Promise<void> {
    if (!this.#activeCommandId) return;
    const record = this.#commands.get(this.#activeCommandId);
    if (!record || record.status !== "running") return;
    record.requestedTerminal = "canceled";
    await terminateProcessTree(record.child);
    await record.completion;
  }

  private snapshot(record: CommandRecord): CommandSnapshot {
    const base: CommandSnapshot = {
      commandId: record.id,
      status: record.status,
      sequence: record.sequence,
      startedAt: new Date(record.startedAt).toISOString(),
      stdout: decodeCapture(record.stdout, record.status !== "running"),
      stderr: decodeCapture(record.stderr, record.status !== "running"),
      stdoutTruncated: record.stdout.truncated,
      stderrTruncated: record.stderr.truncated,
    };
    if (record.finishedAt !== undefined) {
      base.finishedAt = new Date(record.finishedAt).toISOString();
      base.exitCode = record.exitCode ?? null;
      base.signal = record.signal ?? null;
    }
    return base;
  }
}
