import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIsAlive } from "./update-lock.js";

export interface ProcessLeaseOptions {
  lockName: string;
  pollMs: number;
  maxAgeMs: number;
  guardMaxAgeMs: number;
}

interface ProcessLeaseOwner {
  pid: number;
  startedAt: string;
  token: string;
}

interface AcquiredProcessLease {
  file: string;
  token: string;
}

function guardName(lockName: string): string {
  return `${lockName}.guard`;
}

function newOwner(): ProcessLeaseOwner {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

async function readOwner(file: string): Promise<ProcessLeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<ProcessLeaseOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return undefined;
    }
    return value as ProcessLeaseOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function lockIsStale(file: string, maxAgeMs: number): Promise<boolean> {
  const owner = await readOwner(file);
  if (!owner) {
    try {
      const metadata = await stat(file);
      return Date.now() - metadata.mtimeMs > maxAgeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  const ageMs = Date.now() - Date.parse(owner.startedAt);
  return ageMs > maxAgeMs || !processIsAlive(owner.pid);
}

async function acquireGuard(
  directory: string,
  options: ProcessLeaseOptions,
  signal?: AbortSignal,
): Promise<AcquiredProcessLease> {
  const file = path.join(directory, guardName(options.lockName));
  for (;;) {
    signal?.throwIfAborted();
    const owner = newOwner();
    try {
      await writeFile(file, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { file, token: owner.token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await lockIsStale(file, options.guardMaxAgeMs)) {
      await rm(file, { force: true });
      continue;
    }
    await delay(options.pollMs, undefined, signal ? { signal } : undefined);
  }
}

async function removeOwnedLock(file: string, token: string): Promise<void> {
  const owner = await readOwner(file);
  if (owner?.token === token) await rm(file, { force: true });
}

async function withGuard<T>(
  directory: string,
  options: ProcessLeaseOptions,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const guard = await acquireGuard(directory, options, signal);
  try {
    return await action();
  } finally {
    await removeOwnedLock(guard.file, guard.token);
  }
}

async function acquireProcessLease(
  directory: string,
  options: ProcessLeaseOptions,
  signal?: AbortSignal,
): Promise<AcquiredProcessLease> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, options.lockName);
  for (;;) {
    signal?.throwIfAborted();
    const owner = newOwner();
    try {
      await writeFile(file, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { file, token: owner.token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const reclaimed = await withGuard(
      directory,
      options,
      async () => {
        if (!(await lockIsStale(file, options.maxAgeMs))) return false;
        await rm(file, { force: true });
        return true;
      },
      signal,
    );
    if (reclaimed) continue;
    await delay(options.pollMs, undefined, signal ? { signal } : undefined);
  }
}

export async function withProcessLease<T>(
  action: () => Promise<T>,
  options: ProcessLeaseOptions,
  signal: AbortSignal | undefined,
  directory: string,
): Promise<T> {
  const lock = await acquireProcessLease(directory, options, signal);
  try {
    return await action();
  } finally {
    await withGuard(
      directory,
      options,
      async () => await removeOwnedLock(lock.file, lock.token),
      signal,
    );
  }
}
