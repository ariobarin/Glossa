import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  containsRestrictedAuthenticationData,
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_OUTPUT_RANGE_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_OUTPUT_RANGE_BYTES,
  MAX_COMMAND_RETAINED_STREAM_BYTES,
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

export type CommandOutputStream = "stdout" | "stderr";

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

export interface CommandOutputRange {
  commandId: string;
  stream: CommandOutputStream;
  status: CommandStatus;
  offset: number;
  content: string;
  nextOffset?: number;
  retainedBytes: number;
  totalBytes: number;
  retentionTruncated: boolean;
  complete: boolean;
}

interface CapturedStream {
  head: Buffer[];
  headBytes: number;
  tail: Buffer;
  retained: Buffer[];
  retainedBytes: number;
  totalBytes: number;
  retentionTruncated: boolean;
}

interface RenderedStream {
  content: string;
  truncated: boolean;
}

const STREAM_HEAD_BYTES = Math.floor(MAX_COMMAND_OUTPUT_BYTES / 3);
const STREAM_TAIL_BYTES = MAX_COMMAND_OUTPUT_BYTES - STREAM_HEAD_BYTES;
const RESTRICTED_SCAN_TAIL_BYTES = 1024;
const COMMAND_RECORD_RETENTION_MS = 5 * 60 * 1000;
const MAX_RETAINED_COMMAND_RECORDS = 8;
const WINDOWS_DESCENDANT_SNAPSHOT_DELAY_MS = 25;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000;
const WINDOWS_PROCESS_QUERY_MAX_BYTES = 256 * 1024;

interface WindowsProcessIdentity {
  pid: number;
  createdAtFileTime: string;
}

interface WindowsProcessEntry extends WindowsProcessIdentity {
  parentPid: number;
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
  stdoutScanTail: Buffer;
  stderrScanTail: Buffer;
  restrictedDataDetected: boolean;
  completion: Promise<void>;
  complete: () => void;
  requestedTerminal?: "canceled" | "timed_out";
  windowsDescendants?: Promise<WindowsProcessIdentity[]>;
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

function markRestrictedData(record: CommandRecord): void {
  if (record.restrictedDataDetected) return;
  record.restrictedDataDetected = true;
  record.stdout = emptyCapture();
  record.stderr = emptyCapture();
  record.stdoutScanTail = Buffer.alloc(0);
  record.stderrScanTail = Buffer.alloc(0);
  if (record.status === "running") {
    record.requestedTerminal = "canceled";
    void terminateProcessTree(record).catch(() => undefined);
  }
  markChanged(record);
}

function recordCommandOutput(
  record: CommandRecord,
  streamName: CommandOutputStream,
  chunk: Buffer,
): void {
  if (record.restrictedDataDetected || chunk.byteLength === 0) return;
  const tailName = streamName === "stdout" ? "stdoutScanTail" : "stderrScanTail";
  const scan = scanOutputChunk(record[tailName], chunk);
  record[tailName] = scan.tail;
  if (scan.detected) {
    markRestrictedData(record);
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
  const retentionBudget = MAX_COMMAND_RETAINED_STREAM_BYTES - stream.retainedBytes;
  if (retentionBudget > 0) {
    const retained = chunk.subarray(0, Math.min(chunk.byteLength, retentionBudget));
    if (retained.byteLength > 0) {
      stream.retained.push(Buffer.from(retained));
      stream.retainedBytes += retained.byteLength;
    }
  }
  if (chunk.byteLength > Math.max(0, retentionBudget)) {
    stream.retentionTruncated = true;
  }
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
    retained: [],
    retainedBytes: 0,
    totalBytes: 0,
    retentionTruncated: false,
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

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceBytes(byte: number): number {
  if ((byte & 0b1000_0000) === 0) return 1;
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4;
  return 1;
}

function retainedRange(
  stream: CapturedStream,
  requestedOffset: number,
  maxBytes: number,
): { offset: number; content: string; nextOffset?: number } {
  const retained = Buffer.concat(stream.retained, stream.retainedBytes);
  let offset = requestedOffset;
  while (offset < retained.byteLength && isUtf8Continuation(retained[offset])) {
    offset += 1;
  }
  if (offset >= retained.byteLength) {
    return { offset, content: "" };
  }

  let end = Math.min(retained.byteLength, offset + maxBytes);
  if (end < retained.byteLength) {
    while (end > offset && isUtf8Continuation(retained[end])) end -= 1;
  }
  if (end > offset) {
    let lead = end - 1;
    while (lead > offset && isUtf8Continuation(retained[lead])) lead -= 1;
    const expected = utf8SequenceBytes(retained[lead]!);
    if (expected > 1 && end - lead < expected) end = lead;
  }
  if (end <= offset) {
    end = Math.min(retained.byteLength, offset + maxBytes);
  }
  return {
    offset,
    content: retained.subarray(offset, end).toString("utf8"),
    ...(end < retained.byteLength ? { nextOffset: end } : {}),
  };
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

const WINDOWS_PROCESS_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { "{0},{1},{2}" -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc() }';

async function readWindowsProcessTable(): Promise<WindowsProcessEntry[]> {
  if (process.platform !== "win32") return [];
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: WINDOWS_PROCESS_QUERY_MAX_BYTES,
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, output) => resolve(error ? "" : output),
    );
  });
  const entries: WindowsProcessEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidValue, parentPidValue, createdAtFileTime] = line.trim().split(",");
    const pid = Number(pidValue);
    const parentPid = Number(parentPidValue);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(parentPid) ||
      parentPid < 0 ||
      !createdAtFileTime ||
      !/^\d+$/.test(createdAtFileTime)
    ) {
      continue;
    }
    entries.push({ pid, parentPid, createdAtFileTime });
  }
  return entries;
}

function windowsDescendants(
  rootPid: number,
  entries: WindowsProcessEntry[],
): WindowsProcessEntry[] {
  const byParent = new Map<number, WindowsProcessEntry[]>();
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? [];
    children.push(entry);
    byParent.set(entry.parentPid, children);
  }
  const descendants: WindowsProcessEntry[] = [];
  const pending = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

async function terminateWindowsProcessTree(record: CommandRecord): Promise<void> {
  const child = record.child;
  if (!child.pid) return;
  let tracked = record.windowsDescendants
    ? await record.windowsDescendants
    : [];
  const current = await readWindowsProcessTable();
  if (tracked.length === 0 && record.windowsDescendants) {
    tracked = await record.windowsDescendants;
  }
  const currentByPid = new Map(current.map((entry) => [entry.pid, entry]));
  const targets = new Map<number, WindowsProcessEntry>();

  if (child.exitCode === null) {
    const root = currentByPid.get(child.pid);
    if (root) targets.set(root.pid, root);
  }
  for (const identity of tracked) {
    const entry = currentByPid.get(identity.pid);
    if (entry?.createdAtFileTime === identity.createdAtFileTime) {
      targets.set(entry.pid, entry);
    }
  }
  for (const target of [...targets.values()]) {
    for (const descendant of windowsDescendants(target.pid, current)) {
      targets.set(descendant.pid, descendant);
    }
  }
  for (const target of targets.values()) await taskkill(target.pid);
  child.stdout.destroy();
  child.stderr.destroy();
}

async function terminateProcessTree(record: CommandRecord): Promise<void> {
  const child = record.child;
  if (!child.pid) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(record);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await delay(2_000);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

export class CommandService {
  readonly #commands = new Map<string, CommandRecord>();
  #activeCommandId: string | null = null;

  constructor(readonly policy: PathPolicy) {}

  #pruneRetainedCommands(): void {
    while (this.#commands.size >= MAX_RETAINED_COMMAND_RECORDS) {
      const oldestTerminal = [...this.#commands].find(
        ([, record]) => record.status !== "running",
      );
      if (!oldestTerminal) return;
      this.#commands.delete(oldestTerminal[0]);
    }
  }

  #scheduleDeletion(commandId: string): void {
    setTimeout(
      () => this.#commands.delete(commandId),
      COMMAND_RECORD_RETENTION_MS,
    ).unref();
  }

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
        "Windows .cmd and .bat command shims must be run through shellCommand with the explicit shim filename.",
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
      void terminateProcessTree(record);
    }, timeoutMs);
    record.timeout.unref();
    this.#pruneRetainedCommands();
    this.#commands.set(id, record);
    this.#activeCommandId = id;

    child.stdout.on("data", (chunk: Buffer) => {
      recordCommandOutput(record, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      recordCommandOutput(record, "stderr", chunk);
    });
    child.once("exit", () => {
      if (process.platform !== "win32" || !child.pid) return;
      const rootPid = child.pid;
      record.windowsDescendants = delay(WINDOWS_DESCENDANT_SNAPSHOT_DELAY_MS)
        .then(async () => {
          if (record.status !== "running") return [];
          return windowsDescendants(rootPid, await readWindowsProcessTable());
        })
        .catch(() => []);
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
      this.#scheduleDeletion(id);
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
      this.#scheduleDeletion(id);
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

  async readOutput(
    commandId: string,
    streamName: CommandOutputStream,
    offset = 0,
    maxBytes = DEFAULT_COMMAND_OUTPUT_RANGE_BYTES,
  ): Promise<CommandOutputRange> {
    const record = this.#commands.get(commandId);
    if (!record) throw new WorkerError("command_not_found", "The command was not found.");
    if (streamName !== "stdout" && streamName !== "stderr") {
      throw new WorkerError(
        "invalid_output_stream",
        "Command output stream must be stdout or stderr.",
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new WorkerError(
        "invalid_output_offset",
        "Command output offset must be a non-negative integer.",
      );
    }
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > MAX_COMMAND_OUTPUT_RANGE_BYTES
    ) {
      throw new WorkerError(
        "invalid_output_range",
        "Command output range must be between 4 and 65536 source bytes.",
      );
    }
    if (record.restrictedDataDetected) throw restrictedDataError();
    const stream = record[streamName];
    if (offset > stream.retainedBytes) {
      throw new WorkerError(
        "output_offset_out_of_range",
        "The command output offset exceeds the retained stream length.",
      );
    }
    const range = retainedRange(stream, offset, maxBytes);
    if (containsRestrictedAuthenticationData(range.content)) {
      markRestrictedData(record);
      throw restrictedDataError();
    }
    return {
      commandId,
      stream: streamName,
      status: record.status,
      offset: range.offset,
      content: range.content,
      ...(range.nextOffset === undefined ? {} : { nextOffset: range.nextOffset }),
      retainedBytes: stream.retainedBytes,
      totalBytes: stream.totalBytes,
      retentionTruncated: stream.retentionTruncated,
      complete: record.status !== "running",
    };
  }

  async cancel(commandId: string): Promise<CommandSnapshot> {
    const record = this.#commands.get(commandId);
    if (!record) throw new WorkerError("command_not_found", "The command was not found.");
    if (record.status !== "running") return this.snapshot(record);
    record.requestedTerminal = "canceled";
    await terminateProcessTree(record);
    await record.completion;
    return this.snapshot(record);
  }

  async shutdown(): Promise<void> {
    if (!this.#activeCommandId) return;
    const record = this.#commands.get(this.#activeCommandId);
    if (!record || record.status !== "running") return;
    record.requestedTerminal = "canceled";
    await terminateProcessTree(record);
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
