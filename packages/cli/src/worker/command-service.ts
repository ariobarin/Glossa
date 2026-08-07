import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  containsRestrictedAuthenticationData,
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_FAST_WAIT_MS,
  MAX_COMMAND_STATUS_WAIT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  RESTRICTED_DATA_ERROR_CODE,
  RESTRICTED_DATA_ERROR_MESSAGE,
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
  head: Buffer[];
  headBytes: number;
  tail: Buffer;
  totalBytes: number;
}

interface RenderedStream {
  content: string;
  truncated: boolean;
}

const STREAM_HEAD_BYTES = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 3);
const STREAM_TAIL_BYTES = MAX_COMMAND_OUTPUT_BYTES - STREAM_HEAD_BYTES;
const RESTRICTED_SCAN_TAIL_BYTES = 1024;

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
  stdoutScanTail: Buffer;
  stderrScanTail: Buffer;
  restrictedDataDetected: boolean;
  completion: Promise<void>;
  complete: () => void;
  requestedTerminal?: "canceled" | "timed_out";
  timeout?: NodeJS.Timeout;
}

function restrictedDataError(): WorkerError {
  return new WorkerError(
    RESTRICTED_DATA_ERROR_CODE,
    RESTRICTED_DATA_ERROR_MESSAGE,
  );
}

function scanOutputChunk(
  previousTail: Buffer,
  chunk: Buffer,
): { detected: boolean; tail: Buffer } {
  const combined = previousTail.byteLength === 0
    ? chunk
    : Buffer.concat([previousTail, chunk]);
  const tail = combined.byteLength <= RESTRICTED_SCAN_TAIL_BYTES
    ? Buffer.from(combined)
    : Buffer.from(
        combined.subarray(combined.byteLength - RESTRICTED_SCAN_TAIL_BYTES),
      );
  return {
    detected: containsRestrictedAuthenticationData(combined.toString("utf8")),
    tail,
  };
}

function recordCommandOutput(
  record: CommandRecord,
  streamName: "stdout" | "stderr",
  chunk: Buffer,
): void {
  if (record.restrictedDataDetected || chunk.byteLength === 0) return;
  const tailName = streamName === "stdout" ? "stdoutScanTail" : "stderrScanTail";
  const scan = scanOutputChunk(record[tailName], chunk);
  record[tailName] = scan.tail;
  if (scan.detected) {
    record.restrictedDataDetected = true;
    record.stdout = emptyCapture();
    record.stderr = emptyCapture();
    if (record.status === "running") {
      record.requestedTerminal = "canceled";
      void terminateProcessTree(record.child).catch(() => undefined);
    }
    markChanged(record);
    return;
  }
  if (capture(record, record[streamName], chunk)) markChanged(record);
}

function appendTail(existing: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= STREAM_TAIL_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - STREAM_TAIL_BYTES));
  }
  const combined = existing.byteLength === 0
    ? chunk
    : Buffer.concat([existing, chunk]);
  return combined.byteLength <= STREAM_TAIL_BYTES
    ? combined
    : combined.subarray(combined.byteLength - STREAM_TAIL_BYTES);
}

function capture(_record: CommandRecord, stream: CapturedStream, chunk: Buffer): boolean {
  if (chunk.byteLength === 0) return false;
  stream.totalBytes += chunk.byteLength;
  let offset = 0;
  if (stream.headBytes < STREAM_HEAD_BYTES) {
    const accepted = chunk.subarray(
      0,
      Math.min(chunk.byteLength, STREAM_HEAD_BYTES - stream.headBytes),
    );
    if (accepted.byteLength > 0) {
      stream.head.push(Buffer.from(accepted));
      stream.headBytes += accepted.byteLength;
      offset = accepted.byteLength;
    }
  }
  if (offset < chunk.byteLength) {
    stream.tail = appendTail(stream.tail, chunk.subarray(offset));
  }
  return true;
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
  return {
    head: [],
    headBytes: 0,
    tail: Buffer.alloc(0),
    totalBytes: 0,
  };
}

function retainedBytes(stream: CapturedStream, complete: boolean): number {
  const head = Buffer.concat(stream.head, stream.headBytes);
  const retained = Buffer.concat([head, stream.tail]);
  const content = stream.totalBytes <= MAX_COMMAND_OUTPUT_BYTES
    ? (
      complete
        ? retained.toString("utf8")
        : new StringDecoder("utf8").write(retained)
    )
    : safePrefix(head) + safeSuffix(stream.tail);
  return Math.min(Buffer.byteLength(content), MAX_COMMAND_OUTPUT_BYTES);
}

function safePrefix(buffer: Buffer): string {
  return new StringDecoder("utf8").write(buffer);
}

function safeSuffix(buffer: Buffer): string {
  let start = 0;
  while (
    start < buffer.byteLength &&
    (buffer[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1;
  }
  return new StringDecoder("utf8").write(buffer.subarray(start));
}

function utf8PrefixWithinBudget(value: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > budget) break;
    used += bytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function utf8SuffixWithinBudget(value: string, budget: number): string {
  const characters = Array.from(value);
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    const bytes = Buffer.byteLength(characters[start - 1]!);
    if (used + bytes > budget) break;
    used += bytes;
    start -= 1;
  }
  return characters.slice(start).join("");
}

function renderStream(
  stream: CapturedStream,
  budget: number,
  complete: boolean,
): RenderedStream {
  if (budget <= 0 || stream.totalBytes === 0) {
    return { content: "", truncated: stream.totalBytes > 0 };
  }
  const head = Buffer.concat(stream.head, stream.headBytes);
  const retained = Buffer.concat([head, stream.tail]);
  if (stream.totalBytes <= budget) {
    const content = complete
      ? retained.toString("utf8")
      : new StringDecoder("utf8").write(retained);
    if (Buffer.byteLength(content) <= budget) {
      return { content, truncated: false };
    }
    const prefixBudget = Math.floor(budget / 3);
    return {
      content:
        utf8PrefixWithinBudget(content, prefixBudget) +
        utf8SuffixWithinBudget(content, budget - prefixBudget),
      truncated: true,
    };
  }

  const headBudget = Math.min(head.byteLength, Math.floor(budget / 3));
  const tailBudget = Math.min(stream.tail.byteLength, budget - headBudget);
  const remaining = budget - headBudget - tailBudget;
  const extraHead = Math.min(remaining, head.byteLength - headBudget);
  const prefixBudget = headBudget + extraHead;
  const prefix = head.subarray(0, headBudget + extraHead);
  const suffix = stream.tail.subarray(stream.tail.byteLength - tailBudget);
  return {
    content:
      utf8PrefixWithinBudget(safePrefix(prefix), prefixBudget) +
      utf8SuffixWithinBudget(safeSuffix(suffix), tailBudget),
    truncated: true,
  };
}

function renderOutput(
  stdout: CapturedStream,
  stderr: CapturedStream,
  complete: boolean,
): { stdout: RenderedStream; stderr: RenderedStream } {
  const half = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 2);
  const stdoutAvailable = retainedBytes(stdout, complete);
  const stderrAvailable = retainedBytes(stderr, complete);
  let stdoutBudget = Math.min(stdoutAvailable, half);
  let stderrBudget = Math.min(stderrAvailable, half);
  let remaining = MAX_COMMAND_OUTPUT_BYTES - stdoutBudget - stderrBudget;

  const stderrExtra = Math.min(remaining, stderrAvailable - stderrBudget);
  stderrBudget += stderrExtra;
  remaining -= stderrExtra;
  stdoutBudget += Math.min(remaining, stdoutAvailable - stdoutBudget);

  return {
    stdout: renderStream(stdout, stdoutBudget, complete),
    stderr: renderStream(stderr, stderrBudget, complete),
  };
}

function isWindowsCommandShim(file: string): boolean {
  return /\.(?:cmd|bat)$/i.test(file);
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
    if (
      process.platform === "win32" &&
      options.argv &&
      isWindowsCommandShim(options.argv[0]!)
    ) {
      throw new WorkerError(
        "windows_command_shim",
        "Windows .cmd and .bat command shims must be run through shellCommand.",
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
    if (
      containsRestrictedAuthenticationData({
        argv: options.argv,
        shellCommand: options.shellCommand,
        stdin: options.stdin,
      })
    ) {
      throw restrictedDataError();
    }
    const cwd = this.policy.root;
    const invocation = options.argv
      ? { file: options.argv[0]!, args: options.argv.slice(1) }
      : shellInvocation(options.shellCommand!);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      throw new WorkerError(
        "command_spawn_failed",
        "The command could not be started.",
      );
    }
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
      stdoutScanTail: Buffer.alloc(0),
      stderrScanTail: Buffer.alloc(0),
      restrictedDataDetected: false,
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
      recordCommandOutput(record, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      recordCommandOutput(record, "stderr", chunk);
    });
    child.once("error", (error) => {
      if (record.status !== "running") return;
      if (record.timeout) clearTimeout(record.timeout);
      record.status = "failed";
      record.finishedAt = Date.now();
      recordCommandOutput(record, "stderr", Buffer.from(error.message, "utf8"));
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
    }).catch(async () => {
      await record.completion;
      if (record.restrictedDataDetected) throw restrictedDataError();
      throw new WorkerError(
        "command_spawn_failed",
        "The command could not be started.",
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
    if (record.restrictedDataDetected) throw restrictedDataError();
    const output = renderOutput(
      record.stdout,
      record.stderr,
      record.status !== "running",
    );
    const base: CommandSnapshot = {
      commandId: record.id,
      status: record.status,
      sequence: record.sequence,
      startedAt: new Date(record.startedAt).toISOString(),
      stdout: output.stdout.content,
      stderr: output.stderr.content,
      stdoutTruncated: output.stdout.truncated,
      stderrTruncated: output.stderr.truncated,
    };
    if (record.finishedAt !== undefined) {
      base.finishedAt = new Date(record.finishedAt).toISOString();
      base.exitCode = record.exitCode ?? null;
      base.signal = record.signal ?? null;
    }
    return base;
  }
}
