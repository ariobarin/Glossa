import { createHash, randomUUID } from "node:crypto";
import type { Dir, Dirent, Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_EDIT_DIFF_BYTES,
  MAX_LIST_FILES_RESULTS,
  MAX_READ_FILE_RANGE_BYTES,
  MAX_READ_FILE_RANGE_LINES,
  MAX_SEARCH_TEXT_RESULTS,
  MAX_SEARCH_TEXT_SNIPPET_CHARS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  MAX_TEXT_BYTES,
} from "@glossa/protocol";
import { WorkerError } from "./errors.js";
import { samePath, type PathPolicy } from "./path-policy.js";

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
}

const fileWriteTails = new Map<string, Promise<void>>();

async function withFileWriteLock<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const normalized = path.normalize(target);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const predecessor = fileWriteTails.get(key);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileWriteTails.set(key, tail);
  if (predecessor) await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (fileWriteTails.get(key) === tail) fileWriteTails.delete(key);
  }
}

async function withFileWriteLocks<T>(
  targets: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const unique = [...new Set(targets.map((target) => path.normalize(target)))].sort(
    (left, right) => left.localeCompare(right),
  );
  const run = async (index: number): Promise<T> => {
    const target = unique[index];
    return target === undefined
      ? await operation()
      : await withFileWriteLock(target, async () => await run(index + 1));
  };
  return await run(0);
}

async function requireRevision(target: string, expectedSha256: string): Promise<void> {
  let actual: string | null = null;
  try {
    actual = sha256(await readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (actual !== expectedSha256) {
    throw new WorkerError("stale_revision", "The file revision has changed.");
  }
}

export interface ReadTextResult {
  content: string;
  sha256: string;
  bytes: number;
}

export interface ListedFileEntry {
  path: string;
  type: "file" | "directory";
  bytes?: number;
}

export interface ListFilesResult {
  entries: ListedFileEntry[];
  truncated: boolean;
  scannedEntries: number;
  skippedLinks: number;
  nextCursor?: string;
}

export interface SearchTextMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  lineTruncated: boolean;
}

export interface SearchTextResult {
  matches: SearchTextMatch[];
  truncated: boolean;
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  skippedLinks: number;
}

export interface ReadTextRangeResult {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  sha256: string;
  bytes: number;
  contentBytes: number;
  nextLine?: number;
}

export interface WriteTextResult {
  sha256: string;
  bytes: number;
}

export interface EditTextOperation {
  oldText: string;
  newText: string;
}

export interface EditTextResult extends WriteTextResult {
  replacements: number;
  diff: string;
  diffTruncated: boolean;
}

export interface MakeDirectoryResult {
  created: boolean;
}

export interface DeletePathResult {
  deletedType: "file" | "directory";
}

export interface MovePathResult {
  movedType: "file" | "directory";
}

interface LocatedEdit extends EditTextOperation {
  start: number;
  end: number;
}

interface DiffHunk {
  oldStart: number;
  oldEnd: number;
}

interface PendingListPath {
  target: string;
  sortKey: string;
  path: string;
  name: string;
}

interface BufferedListEntry {
  entry: ListedFileEntry;
  cursor: string;
}

type LateValueCleanup<T> = (value: T) => Promise<void> | void;
type DeadlineRunner = <T>(
  operation: Promise<T>,
  deadlineAt: number,
  onLateValue?: LateValueCleanup<T>,
) => Promise<T>;
type OpenDirectory = (directory: string) => Promise<Dir>;
type ReadFileBytes = (
  target: string,
  maximumBytes: number,
  expectedBytes: number,
) => Promise<Buffer>;
type LstatPath = (target: string) => Promise<Stats>;

interface FileServiceDependencies {
  now?: () => number;
  beforeDeadline?: DeadlineRunner;
  openDirectory?: OpenDirectory;
  readFileBytes?: ReadFileBytes;
  lstatPath?: LstatPath;
  trustDirectoryEntryTypes?: boolean;
  maxRepositoryScanEntries?: number;
  maxSearchBytes?: number;
}

const DEFAULT_LIST_FILES_LIMIT = 100;
const DEFAULT_SEARCH_TEXT_RESULTS = 50;
const DEFAULT_READ_RANGE_LINES = 200;
const MAX_REPOSITORY_SCAN_ENTRIES = 20_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const SKIPPED_RECURSIVE_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relativeSortKey(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative) return ".";
  return process.platform === "win32"
    ? relative.replaceAll("\\", "/")
    : relative;
}

function displayPath(root: string, target: string): string {
  const relative = relativeSortKey(root, target);
  if (process.platform === "win32") return relative;
  return relative.includes("\\") ? "./" + relative : relative;
}

function isUnavailableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOTDIR"
  );
}

function isUnavailableDiscoveredPathError(error: unknown): boolean {
  return (
    isUnavailableFileError(error) ||
    (error instanceof WorkerError && error.code === "path_not_found")
  );
}

function isLinkedPathError(error: unknown): boolean {
  return error instanceof WorkerError && error.code === "linked_path";
}

async function readBoundedFile(
  target: string,
  maximumBytes: number,
  expectedBytes: number,
): Promise<Buffer> {
  const handle = await open(target, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new WorkerError("not_file", "The requested path is not a file.");
    }
    if (openedStat.size !== expectedBytes) {
      throw new WorkerError("file_changed", "The file changed while it was being read.");
    }
    if (openedStat.size > maximumBytes) {
      throw new WorkerError("search_byte_limit", "The search byte limit was reached.");
    }
    const buffer = Buffer.allocUnsafe(openedStat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const completedStat = await handle.stat();
    if (completedStat.size !== openedStat.size || offset !== openedStat.size) {
      throw new WorkerError("file_changed", "The file changed while it was being read.");
    }
    return Buffer.from(buffer);
  } finally {
    await handle.close();
  }
}

function normalizedLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function heapPush(
  heap: PendingListPath[],
  value: PendingListPath,
): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareNames(heap[parent]!.sortKey, value.sortKey) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: PendingListPath[]): PendingListPath | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child =
      right < heap.length &&
      compareNames(heap[right]!.sortKey, heap[left]!.sortKey) < 0
        ? right
        : left;
    if (compareNames(last.sortKey, heap[child]!.sortKey) <= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function scanTimeoutError(): WorkerError {
  return new WorkerError(
    "scan_timeout",
    "The structured repository operation exceeded its local deadline.",
  );
}

async function defaultBeforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  onLateValue?: LateValueCleanup<T>,
): Promise<T> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const remainingMs = deadlineAt - performance.now();
  const expired = Symbol("structured_read_deadline");
  let winner: Awaited<typeof settled> | typeof expired;
  let timer: NodeJS.Timeout | undefined;

  if (remainingMs <= 0) {
    winner = expired;
  } else {
    try {
      winner = await Promise.race([
        settled,
        new Promise<typeof expired>((resolve) => {
          timer = setTimeout(() => resolve(expired), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (winner === expired) {
    const eventual = await settled;
    if (eventual.ok && onLateValue) {
      await onLateValue(eventual.value);
    }
    throw scanTimeoutError();
  }
  if (!winner.ok) throw winner.error;
  return winner.value;
}

async function closeDirectory(handle: Dir): Promise<void> {
  await handle.close().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ERR_DIR_CLOSED") throw error;
  });
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new WorkerError(
      "invalid_limit",
      `${label} must be between 1 and ${maximum}.`,
    );
  }
  return resolved;
}

function searchSnippet(
  line: string,
  matchIndex: number,
  matchLength: number,
): { text: string; truncated: boolean } {
  if (line.length <= MAX_SEARCH_TEXT_SNIPPET_CHARS) {
    return { text: line, truncated: false };
  }
  const windowLength = MAX_SEARCH_TEXT_SNIPPET_CHARS - 6;
  let start = Math.max(0, matchIndex - 120);
  if (start + windowLength < matchIndex + matchLength) {
    start = matchIndex + matchLength - windowLength;
  }
  start = Math.min(start, line.length - windowLength);
  const end = start + windowLength;
  return {
    text: `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`,
    truncated: true,
  };
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function lineStart(content: string, index: number): number {
  return content.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(content: string, start: number, end: number): number {
  const changedIndex = Math.max(start, end - 1);
  const newline = content.indexOf("\n", changedIndex);
  return newline === -1 ? content.length : newline + 1;
}

function diffLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function mappedIndex(index: number, edits: LocatedEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.end > index) break;
    delta += edit.newText.length - (edit.end - edit.start);
  }
  return index + delta;
}

function createUnifiedDiff(
  relativePath: string,
  original: string,
  updated: string,
  edits: LocatedEdit[],
): string {
  const hunks: DiffHunk[] = [];
  for (const edit of edits) {
    const candidate = {
      oldStart: lineStart(original, edit.start),
      oldEnd: lineEnd(original, edit.start, edit.end),
    };
    const previous = hunks.at(-1);
    if (previous && candidate.oldStart <= previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, candidate.oldEnd);
    } else {
      hunks.push(candidate);
    }
  }

  const displayPath = process.platform === "win32"
    ? relativePath.replaceAll("\\", "/")
    : relativePath;
  const lines = [`--- a/${displayPath}`, `+++ b/${displayPath}`];
  for (const hunk of hunks) {
    const newStart = mappedIndex(hunk.oldStart, edits);
    const newEnd = mappedIndex(hunk.oldEnd, edits);
    const oldLines = diffLines(original.slice(hunk.oldStart, hunk.oldEnd));
    const newLines = diffLines(updated.slice(newStart, newEnd));
    lines.push(
      `@@ -${lineNumberAt(original, hunk.oldStart)},${oldLines.length} +${lineNumberAt(updated, newStart)},${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function boundDiff(diff: string): { diff: string; truncated: boolean } {
  const encoded = Buffer.from(diff, "utf8");
  if (encoded.byteLength <= MAX_EDIT_DIFF_BYTES) {
    return { diff, truncated: false };
  }
  const marker = "\n... diff truncated by Glossa ...\n";
  const available = Math.max(
    0,
    MAX_EDIT_DIFF_BYTES - Buffer.byteLength(marker, "utf8"),
  );
  const prefix = new StringDecoder("utf8").write(encoded.subarray(0, available));
  return { diff: `${prefix}${marker}`, truncated: true };
}

export class FileService {
  readonly #now: () => number;
  readonly #beforeDeadline: DeadlineRunner;
  readonly #openDirectory: OpenDirectory;
  readonly #readFileBytes: ReadFileBytes;
  readonly #lstatPath: LstatPath;
  readonly #trustDirectoryEntryTypes: boolean;
  readonly #maxRepositoryScanEntries: number;
  readonly #maxSearchBytes: number;

  constructor(
    readonly policy: PathPolicy,
    dependencies: FileServiceDependencies = {},
  ) {
    this.#now = dependencies.now ?? (() => performance.now());
    this.#beforeDeadline = dependencies.beforeDeadline ?? defaultBeforeDeadline;
    this.#openDirectory = dependencies.openDirectory ?? ((directory) => opendir(directory));
    this.#readFileBytes = dependencies.readFileBytes ?? readBoundedFile;
    this.#lstatPath = dependencies.lstatPath ?? ((target) => lstat(target));
    this.#trustDirectoryEntryTypes =
      dependencies.trustDirectoryEntryTypes ?? dependencies.lstatPath === undefined;
    this.#maxRepositoryScanEntries =
      dependencies.maxRepositoryScanEntries ?? MAX_REPOSITORY_SCAN_ENTRIES;
    this.#maxSearchBytes = dependencies.maxSearchBytes ?? MAX_SEARCH_BYTES;
    if (
      !Number.isInteger(this.#maxRepositoryScanEntries) ||
      this.#maxRepositoryScanEntries < 1 ||
      this.#maxRepositoryScanEntries > MAX_REPOSITORY_SCAN_ENTRIES
    ) {
      throw new WorkerError(
        "invalid_limit",
        `Repository scan limit must be between 1 and ${MAX_REPOSITORY_SCAN_ENTRIES}.`,
      );
    }
    if (
      !Number.isInteger(this.#maxSearchBytes) ||
      this.#maxSearchBytes < 1 ||
      this.#maxSearchBytes > MAX_SEARCH_BYTES
    ) {
      throw new WorkerError(
        "invalid_limit",
        `Search byte limit must be between 1 and ${MAX_SEARCH_BYTES}.`,
      );
    }
  }

  #scanDeadline(timeoutMs = MAX_STRUCTURED_READ_TIMEOUT_MS): number {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_STRUCTURED_READ_TIMEOUT_MS
    ) {
      throw new WorkerError(
        "invalid_timeout",
        `Structured read timeout must be between 1 and ${MAX_STRUCTURED_READ_TIMEOUT_MS}.`,
      );
    }
    return this.#now() + timeoutMs;
  }

  async #withinDeadline<T>(
    operation: Promise<T>,
    deadlineAt: number,
    onLateValue?: LateValueCleanup<T>,
  ): Promise<T> {
    return await this.#beforeDeadline(operation, deadlineAt, onLateValue);
  }

  #assertBeforeDeadline(deadlineAt: number): void {
    if (this.#now() >= deadlineAt) {
      throw new WorkerError(
        "scan_timeout",
        "The structured repository operation exceeded its local deadline.",
      );
    }
  }

  async #readDirectoryBounded(
    directory: string,
    deadlineAt: number,
    remainingEntries: number,
  ): Promise<{ children: Dirent[]; overflow: boolean }> {
    const handle = await this.#withinDeadline(
      this.#openDirectory(directory),
      deadlineAt,
      closeDirectory,
    );
    const children: Dirent[] = [];
    try {
      while (true) {
        this.#assertBeforeDeadline(deadlineAt);
        const child = await this.#withinDeadline(handle.read(), deadlineAt);
        if (!child) break;
        if (children.length >= remainingEntries) {
          return { children: [], overflow: true };
        }
        children.push(child);
      }
    } finally {
      await closeDirectory(handle);
    }
    children.sort((left, right) => compareNames(left.name, right.name));
    return { children, overflow: false };
  }

  async #readResolvedText(
    target: string,
    maximumBytes = MAX_TEXT_BYTES,
  ): Promise<ReadTextResult> {
    const boundedMaximum = Math.min(maximumBytes, MAX_TEXT_BYTES);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new WorkerError("not_file", "The requested path is not a file.");
    }
    if (targetStat.size > MAX_TEXT_BYTES) {
      throw new WorkerError("file_too_large", "The file exceeds the 1 MiB text limit.");
    }
    if (targetStat.size > boundedMaximum) {
      throw new WorkerError("search_byte_limit", "The search byte limit was reached.");
    }
    const content = await this.#readFileBytes(
      target,
      boundedMaximum,
      targetStat.size,
    );
    if (content.byteLength > MAX_TEXT_BYTES) {
      throw new WorkerError("file_too_large", "The file exceeds the 1 MiB text limit.");
    }
    if (content.byteLength > boundedMaximum) {
      throw new WorkerError("search_byte_limit", "The search byte limit was reached.");
    }
    if (content.byteLength > targetStat.size) {
      throw new WorkerError("file_changed", "The file changed while it was being read.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new WorkerError("not_text", "The file is not valid UTF-8 text.");
    }
    return { content: text, sha256: sha256(content), bytes: content.byteLength };
  }

  async readText(relativePath: string): Promise<ReadTextResult> {
    const target = await this.policy.resolveExisting(relativePath);
    return await this.#readResolvedText(target);
  }

  async listFiles(options: {
    path?: string;
    recursive?: boolean;
    cursor?: string;
    limit?: number;
    timeoutMs?: number;
  } = {}): Promise<ListFilesResult> {
    const deadlineAt = this.#scanDeadline(options.timeoutMs);
    const startPath = options.path ?? ".";
    const start = await this.#withinDeadline(
      this.policy.resolveExisting(startPath),
      deadlineAt,
    );
    const startStat = await this.#withinDeadline(stat(start), deadlineAt);
    if (!startStat.isDirectory()) {
      throw new WorkerError("not_directory", "The requested path is not a directory.");
    }
    const limit = boundedPositiveInteger(
      options.limit,
      DEFAULT_LIST_FILES_LIMIT,
      MAX_LIST_FILES_RESULTS,
      "List limit",
    );
    const cursor = process.platform === "win32"
      ? options.cursor?.replaceAll("\\", "/")
      : options.cursor;
    const entries: BufferedListEntry[] = [];
    const frontier: PendingListPath[] = [];
    let scannedEntries = 0;
    let skippedLinks = 0;
    let hasMore = false;

    const scanLimitError = (): WorkerError => new WorkerError(
      "scan_limit",
      `The directory scan exceeds ${this.#maxRepositoryScanEntries} entries. Narrow the requested path.`,
    );

    const enqueueChildren = async (directory: string): Promise<void> => {
      const batch = await this.#readDirectoryBounded(
        directory,
        deadlineAt,
        this.#maxRepositoryScanEntries - scannedEntries,
      );
      if (batch.overflow) throw scanLimitError();
      scannedEntries += batch.children.length;
      for (const child of batch.children) {
        const target = path.join(directory, child.name);
        heapPush(frontier, {
          target,
          sortKey: relativeSortKey(this.policy.root, target),
          path: displayPath(this.policy.root, target),
          name: child.name,
        });
      }
    };

    const hasListableChild = async (directory: string): Promise<boolean> => {
      const handle = await this.#withinDeadline(
        this.#openDirectory(directory),
        deadlineAt,
        closeDirectory,
      );
      try {
        while (true) {
          this.#assertBeforeDeadline(deadlineAt);
          const child = await this.#withinDeadline(handle.read(), deadlineAt);
          if (!child) return false;
          if (scannedEntries >= this.#maxRepositoryScanEntries) {
            throw scanLimitError();
          }
          scannedEntries += 1;
          const target = path.join(directory, child.name);
          let childStat;
          try {
            childStat = await this.#withinDeadline(
              this.#lstatPath(target),
              deadlineAt,
            );
          } catch (error) {
            if (isUnavailableFileError(error)) continue;
            throw error;
          }
          if (childStat.isSymbolicLink()) {
            skippedLinks += 1;
            continue;
          }
          if (childStat.isFile() || childStat.isDirectory()) return true;
        }
      } finally {
        await closeDirectory(handle);
      }
    };

    await enqueueChildren(start);
    while (frontier.length > 0 && entries.length <= limit) {
      this.#assertBeforeDeadline(deadlineAt);
      const candidate = heapPop(frontier)!;
      let targetStat;
      try {
        targetStat = await this.#withinDeadline(
          this.#lstatPath(candidate.target),
          deadlineAt,
        );
      } catch (error) {
        if (isUnavailableFileError(error)) continue;
        throw error;
      }
      if (targetStat.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      const type = targetStat.isDirectory()
        ? "directory"
        : targetStat.isFile()
          ? "file"
          : undefined;
      if (!type) continue;
      if (
        entries.length === limit &&
        (!cursor || compareNames(candidate.sortKey, cursor) > 0)
      ) {
        try {
          const safeCandidate = await this.#withinDeadline(
            this.policy.resolveDiscoveredExisting(candidate.target),
            deadlineAt,
          );
          if (
            type === "directory" &&
            options.recursive === true &&
            !SKIPPED_RECURSIVE_DIRECTORIES.has(candidate.name.toLowerCase())
          ) {
            const handle = await this.#withinDeadline(
              this.#openDirectory(safeCandidate),
              deadlineAt,
              closeDirectory,
            );
            await closeDirectory(handle);
          }
        } catch (error) {
          if (isUnavailableDiscoveredPathError(error)) continue;
          if (isLinkedPathError(error)) {
            skippedLinks += 1;
            continue;
          }
          throw error;
        }
        hasMore = true;
        break;
      }
      const shouldReturn = !cursor || compareNames(candidate.sortKey, cursor) > 0;
      const shouldRecurse =
        type === "directory" &&
        options.recursive === true &&
        !SKIPPED_RECURSIVE_DIRECTORIES.has(candidate.name.toLowerCase());
      let safeDirectory: string | undefined;
      if (shouldRecurse) {
        try {
          safeDirectory = await this.#withinDeadline(
            this.policy.resolveDiscoveredExisting(candidate.target),
            deadlineAt,
          );
        } catch (error) {
          if (isUnavailableDiscoveredPathError(error)) continue;
          if (isLinkedPathError(error)) {
            skippedLinks += 1;
            continue;
          }
          throw error;
        }
      }
      const fillsPage = shouldReturn && entries.length + 1 === limit;
      if (fillsPage && safeDirectory) {
        let hasChild: boolean;
        try {
          hasChild = await hasListableChild(safeDirectory);
        } catch (error) {
          if (isUnavailableDiscoveredPathError(error)) continue;
          throw error;
        }
        entries.push({
          entry: { path: candidate.path, type },
          cursor: candidate.sortKey,
        });
        if (hasChild) {
          hasMore = true;
          break;
        }
        continue;
      }
      if (safeDirectory) {
        try {
          await enqueueChildren(safeDirectory);
        } catch (error) {
          if (isUnavailableDiscoveredPathError(error)) continue;
          throw error;
        }
      }
      if (shouldReturn) {
        entries.push({
          entry: {
            path: candidate.path,
            type,
            ...(type === "file" ? { bytes: targetStat.size } : {}),
          },
          cursor: candidate.sortKey,
        });
      }
    }

    return {
      entries: entries.map(({ entry }) => entry),
      truncated: hasMore,
      scannedEntries,
      skippedLinks,
      ...(hasMore && entries.length > 0
        ? { nextCursor: entries.at(-1)!.cursor }
        : {}),
    };
  }

  async searchText(options: {
    query: string;
    path?: string;
    matchMode?: "literal" | "regex";
    caseSensitive?: boolean;
    maxResults?: number;
    extensions?: string[];
    includeGlobs?: string[];
    excludeGlobs?: string[];
    timeoutMs?: number;
  }): Promise<SearchTextResult> {
    const deadlineAt = this.#scanDeadline(options.timeoutMs);
    if (
      options.query.length === 0 ||
      options.query.length > 256 ||
      /[\r\n\u0000]/.test(options.query)
    ) {
      throw new WorkerError(
        "invalid_search",
        "Search text must be one non-empty line of at most 256 characters.",
      );
    }
    const maxResults = boundedPositiveInteger(
      options.maxResults,
      DEFAULT_SEARCH_TEXT_RESULTS,
      MAX_SEARCH_TEXT_RESULTS,
      "Search result limit",
    );
    const matchLimit = maxResults + 1;
    const extensions = options.extensions
      ?.map((extension) => extension.toLowerCase());
    const includeGlobs = options.includeGlobs;
    const excludeGlobs = options.excludeGlobs;
    const globMatches = (relativePath: string, patterns: string[] | undefined): boolean => {
      if (!patterns) return false;
      const normalized = relativePath.replaceAll("\\", "/");
      try {
        return patterns.some((pattern) => path.posix.matchesGlob(normalized, pattern));
      } catch {
        throw new WorkerError("invalid_search", "Search glob pattern is invalid.");
      }
    };
    let matcher: RegExp;
    try {
      matcher = new RegExp(
        options.matchMode === "regex" ? options.query : escapeRegExp(options.query),
        options.caseSensitive === true ? "u" : "iu",
      );
    } catch {
      throw new WorkerError("invalid_search", "Search regular expression is invalid.");
    }
    const start = await this.#withinDeadline(
      this.policy.resolveExisting(options.path ?? "."),
      deadlineAt,
    );
    const startStat = await this.#withinDeadline(stat(start), deadlineAt);
    const matches: SearchTextMatch[] = [];
    let scannedEntries = 0;
    let scannedFiles = 0;
    let scannedBytes = 0;
    let skippedFiles = 0;
    let skippedLinks = 0;
    let scanTruncated = false;

    const searchFile = async (target: string): Promise<boolean> => {
      const relative = displayPath(this.policy.root, target);
      if (
        extensions &&
        !extensions.some((extension) =>
          path.basename(target).toLowerCase().endsWith(extension)
        )
      ) {
        return false;
      }
      if (includeGlobs && !globMatches(relative, includeGlobs)) return false;
      if (globMatches(relative, excludeGlobs)) return false;
      if (scannedFiles >= MAX_SEARCH_FILES) {
        scanTruncated = true;
        return true;
      }
      const remainingBytes = this.#maxSearchBytes - scannedBytes;
      if (remainingBytes <= 0) {
        scanTruncated = true;
        return true;
      }
      let result: ReadTextResult;
      try {
        const safeTarget = await this.#withinDeadline(
          this.policy.resolveDiscoveredExisting(target),
          deadlineAt,
        );
        result = await this.#withinDeadline(
          this.#readResolvedText(safeTarget, remainingBytes),
          deadlineAt,
        );
      } catch (error) {
        if (error instanceof WorkerError && error.code === "search_byte_limit") {
          scanTruncated = true;
          return true;
        }
        if (isLinkedPathError(error)) {
          skippedLinks += 1;
          return false;
        }
        if (
          isUnavailableFileError(error) ||
          (error instanceof WorkerError &&
            [
              "not_text",
              "not_file",
              "file_too_large",
              "file_changed",
              "path_not_found",
            ].includes(
              error.code,
            ))
        ) {
          skippedFiles += 1;
          return false;
        }
        throw error;
      }
      if (scannedBytes + result.bytes > this.#maxSearchBytes) {
        scanTruncated = true;
        return true;
      }
      scannedFiles += 1;
      scannedBytes += result.bytes;
      const lines = result.content.replace(/\r\n?/g, "\n").split("\n");
      for (const [index, line] of lines.entries()) {
        if (index % 256 === 0) this.#assertBeforeDeadline(deadlineAt);
        const match = matcher.exec(line);
        if (!match) continue;
        const matchIndex = match.index;
        const snippet = searchSnippet(line, matchIndex, match[0].length);
        matches.push({
          path: relative,
          line: index + 1,
          column: matchIndex + 1,
          text: snippet.text,
          lineTruncated: snippet.truncated,
        });
        if (matches.length >= matchLimit) return true;
      }
      return false;
    };

    const visit = async (directory: string): Promise<boolean> => {
      let batch;
      try {
        batch = await this.#readDirectoryBounded(
          directory,
          deadlineAt,
          this.#maxRepositoryScanEntries - scannedEntries,
        );
      } catch (error) {
        if (isUnavailableFileError(error)) {
          skippedFiles += 1;
          return false;
        }
        throw error;
      }
      if (batch.overflow) {
        scanTruncated = true;
        scannedEntries = this.#maxRepositoryScanEntries;
        return true;
      }
      scannedEntries += batch.children.length;
      for (const child of batch.children) {
        this.#assertBeforeDeadline(deadlineAt);
        const target = path.join(directory, child.name);
        let targetType: "directory" | "file" | undefined;
        if (this.#trustDirectoryEntryTypes) {
          if (child.isSymbolicLink()) {
            skippedLinks += 1;
            continue;
          }
          if (child.isDirectory()) targetType = "directory";
          else if (child.isFile()) targetType = "file";
        }
        if (!targetType) {
          let targetStat;
          try {
            targetStat = await this.#withinDeadline(
              this.#lstatPath(target),
              deadlineAt,
            );
          } catch (error) {
            if (isUnavailableFileError(error)) {
              skippedFiles += 1;
              continue;
            }
            throw error;
          }
          if (targetStat.isSymbolicLink()) {
            skippedLinks += 1;
            continue;
          }
          if (targetStat.isDirectory()) targetType = "directory";
          else if (targetStat.isFile()) targetType = "file";
        }
        if (targetType === "directory") {
          if (SKIPPED_RECURSIVE_DIRECTORIES.has(child.name.toLowerCase())) continue;
          try {
            await this.#withinDeadline(
              this.policy.resolveDiscoveredExisting(target),
              deadlineAt,
            );
          } catch (error) {
            if (isLinkedPathError(error)) {
              skippedLinks += 1;
              continue;
            }
            if (isUnavailableDiscoveredPathError(error)) {
              skippedFiles += 1;
              continue;
            }
            throw error;
          }
          if (await visit(target)) return true;
        } else if (targetType === "file" && await searchFile(target)) {
          return true;
        }
      }
      return false;
    };

    if (startStat.isFile()) {
      await searchFile(start);
    } else if (startStat.isDirectory()) {
      await visit(start);
    } else {
      throw new WorkerError("not_file", "The requested path is not a file or directory.");
    }

    return {
      matches: matches.slice(0, maxResults),
      truncated: scanTruncated || matches.length > maxResults,
      scannedFiles,
      scannedBytes,
      skippedFiles,
      skippedLinks,
    };
  }

  async readTextRange(
    relativePath: string,
    startLine = 1,
    lineCount = DEFAULT_READ_RANGE_LINES,
    timeoutMs = MAX_STRUCTURED_READ_TIMEOUT_MS,
  ): Promise<ReadTextRangeResult> {
    const deadlineAt = this.#scanDeadline(timeoutMs);
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new WorkerError("invalid_range", "Start line must be a positive integer.");
    }
    lineCount = boundedPositiveInteger(
      lineCount,
      DEFAULT_READ_RANGE_LINES,
      MAX_READ_FILE_RANGE_LINES,
      "Line count",
    );
    const file = await this.#withinDeadline(
      this.readText(relativePath),
      deadlineAt,
    );
    const lines = normalizedLines(file.content);
    if (lines.length === 0) {
      if (startLine !== 1) {
        throw new WorkerError("line_out_of_range", "The requested line is outside the file.");
      }
      return {
        content: "",
        startLine: 1,
        endLine: 0,
        totalLines: 0,
        sha256: file.sha256,
        bytes: file.bytes,
        contentBytes: 0,
      };
    }
    if (startLine > lines.length) {
      throw new WorkerError("line_out_of_range", "The requested line is outside the file.");
    }
    const selected: string[] = [];
    let contentBytes = 0;
    const requestedEnd = Math.min(lines.length, startLine - 1 + lineCount);
    for (let index = startLine - 1; index < requestedEnd; index += 1) {
      const line = lines[index]!;
      const addedBytes = Buffer.byteLength(line, "utf8") +
        (selected.length === 0 ? 0 : 1);
      if (contentBytes + addedBytes > MAX_READ_FILE_RANGE_BYTES) {
        if (selected.length === 0) {
          throw new WorkerError(
            "line_too_large",
            "The first requested line exceeds the 64 KiB range limit. Use read_file instead.",
          );
        }
        break;
      }
      selected.push(line);
      contentBytes += addedBytes;
    }
    const endLine = startLine + selected.length - 1;
    return {
      content: selected.join("\n"),
      startLine,
      endLine,
      totalLines: lines.length,
      sha256: file.sha256,
      bytes: file.bytes,
      contentBytes,
      ...(endLine < lines.length ? { nextLine: endLine + 1 } : {}),
    };
  }

  async makeDirectory(
    relativePath: string,
    recursive = false,
  ): Promise<MakeDirectoryResult> {
    const initial = await this.policy.resolveWritableDirectory(
      relativePath,
      recursive,
    );
    if (initial.exists) return { created: false };
    return await withFileWriteLock(initial.target, async () => {
      const current = await this.policy.resolveWritableDirectory(
        relativePath,
        recursive,
      );
      if (current.exists) return { created: false };
      try {
        await mkdir(current.target, { recursive });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const resolved = await this.policy.resolveExisting(relativePath);
      if (!(await stat(resolved)).isDirectory()) {
        throw new WorkerError("not_directory", "The destination is not a directory.");
      }
      return { created: true };
    });
  }

  async deletePath(
    relativePath: string,
    recursive = false,
  ): Promise<DeletePathResult> {
    const initial = await this.policy.resolveExisting(relativePath);
    if (samePath(initial, this.policy.root)) {
      throw new WorkerError(
        "root_operation_refused",
        "The exposed workspace root cannot be deleted.",
      );
    }
    return await withFileWriteLock(initial, async () => {
      const target = await this.policy.resolveExisting(relativePath);
      if (samePath(target, this.policy.root)) {
        throw new WorkerError(
          "root_operation_refused",
          "The exposed workspace root cannot be deleted.",
        );
      }
      const targetStat = await lstat(target);
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new WorkerError(
          "unsupported_path_type",
          "Only regular files and directories can be deleted.",
        );
      }
      try {
        if (targetStat.isDirectory()) {
          if (recursive) {
            await rm(target, { recursive: true, force: false });
          } else {
            await rmdir(target);
          }
        } else {
          await rm(target, { force: false });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          targetStat.isDirectory() &&
          !recursive &&
          (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM")
        ) {
          throw new WorkerError(
            "directory_not_empty",
            "The directory is not empty. Set recursive to true to delete its contents.",
          );
        }
        throw error;
      }
      return {
        deletedType: targetStat.isDirectory() ? "directory" : "file",
      };
    });
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
  ): Promise<MovePathResult> {
    const initialSource = await this.policy.resolveExisting(sourcePath);
    if (samePath(initialSource, this.policy.root)) {
      throw new WorkerError(
        "root_operation_refused",
        "The exposed workspace root cannot be moved.",
      );
    }
    const initialDestination = await this.policy.resolveVacantPath(destinationPath);
    return await withFileWriteLocks(
      [initialSource, initialDestination],
      async () => {
        const source = await this.policy.resolveExisting(sourcePath);
        if (samePath(source, this.policy.root)) {
          throw new WorkerError(
            "root_operation_refused",
            "The exposed workspace root cannot be moved.",
          );
        }
        const destination = await this.policy.resolveVacantPath(destinationPath);
        const sourceStat = await lstat(source);
        if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
          throw new WorkerError(
            "unsupported_path_type",
            "Only regular files and directories can be moved.",
          );
        }
        if (sourceStat.isDirectory() && isPathWithin(source, destination)) {
          throw new WorkerError(
            "invalid_destination",
            "A directory cannot be moved inside itself.",
          );
        }
        await rename(source, destination);
        return {
          movedType: sourceStat.isDirectory() ? "directory" : "file",
        };
      },
    );
  }

  async editText(
    relativePath: string,
    edits: EditTextOperation[],
    expectedSha256?: string,
  ): Promise<EditTextResult> {
    const original = await this.readText(relativePath);
    if (expectedSha256 && original.sha256 !== expectedSha256) {
      throw new WorkerError("stale_revision", "The file revision has changed.");
    }

    const located = edits
      .map((edit): LocatedEdit => {
        const start = original.content.indexOf(edit.oldText);
        if (start === -1) {
          throw new WorkerError("edit_not_found", "The edit target was not found.");
        }
        if (original.content.indexOf(edit.oldText, start + 1) !== -1) {
          throw new WorkerError(
            "edit_ambiguous",
            "The edit target occurs more than once.",
          );
        }
        return { ...edit, start, end: start + edit.oldText.length };
      })
      .sort((left, right) => left.start - right.start);

    for (let index = 1; index < located.length; index += 1) {
      if (located[index]!.start < located[index - 1]!.end) {
        throw new WorkerError("edit_overlap", "The requested edits overlap.");
      }
    }

    let cursor = 0;
    let updated = "";
    for (const edit of located) {
      updated += original.content.slice(cursor, edit.start);
      updated += edit.newText;
      cursor = edit.end;
    }
    updated += original.content.slice(cursor);

    const rendered = boundDiff(
      createUnifiedDiff(relativePath, original.content, updated, located),
    );
    const written = await this.writeText(relativePath, updated, original.sha256);
    return {
      ...written,
      replacements: located.length,
      diff: rendered.diff,
      diffTruncated: rendered.truncated,
    };
  }

  async writeText(
    relativePath: string,
    content: string,
    expectedSha256?: string,
  ): Promise<WriteTextResult> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      throw new WorkerError("file_too_large", "The content exceeds the 1 MiB text limit.");
    }

    let target = await this.policy.resolveWritableFile(relativePath);
    return await withFileWriteLock(target, async () => {
      let existingMode: number | undefined;
      try {
        const existingStat = await stat(target);
        if (existingStat.isFile()) existingMode = existingStat.mode & 0o7777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (expectedSha256) await requireRevision(target, expectedSha256);

      const temporary = path.join(path.dirname(target), `.glossa-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        target = await this.policy.resolveWritableFile(relativePath);
        const tempStat = await lstat(temporary);
        if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
          throw new WorkerError("unsafe_temporary_file", "The atomic write temporary file changed.");
        }
        if (existingMode !== undefined && process.platform !== "win32") {
          await chmod(temporary, existingMode);
        }
        if (expectedSha256) await requireRevision(target, expectedSha256);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }

      return { sha256: sha256(bytes), bytes: bytes.byteLength };
    });
  }
}
