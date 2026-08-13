import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIsAlive, updateRuntimeDirectory } from "./update-lock.js";

const DEVICE_PAIRING_LOCK = "device-pairing.lock";
const DEVICE_PAIRING_LOCK_GUARD = "device-pairing.lock.guard";
const DEVICE_PAIRING_LOCK_POLL_MS = 100;
const DEVICE_PAIRING_LOCK_MAX_AGE_MS = 6 * 60_000;
const DEVICE_PAIRING_GUARD_MAX_AGE_MS = 30_000;

interface DevicePairingLockOwner {
  pid: number;
  startedAt: string;
  token: string;
}

interface AcquiredDevicePairingLock {
  file: string;
  token: string;
}

function lockPath(directory: string): string {
  return path.join(directory, DEVICE_PAIRING_LOCK);
}

function guardPath(directory: string): string {
  return path.join(directory, DEVICE_PAIRING_LOCK_GUARD);
}

function newOwner(): DevicePairingLockOwner {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
}

async function readOwner(file: string): Promise<DevicePairingLockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<DevicePairingLockOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return undefined;
    }
    return value as DevicePairingLockOwner;
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
  signal?: AbortSignal,
): Promise<AcquiredDevicePairingLock> {
  const file = guardPath(directory);
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
    if (await lockIsStale(file, DEVICE_PAIRING_GUARD_MAX_AGE_MS)) {
      await rm(file, { force: true });
      continue;
    }
    await delay(
      DEVICE_PAIRING_LOCK_POLL_MS,
      undefined,
      signal ? { signal } : undefined,
    );
  }
}

async function removeOwnedLock(file: string, token: string): Promise<void> {
  const owner = await readOwner(file);
  if (owner?.token === token) await rm(file, { force: true });
}

async function withGuard<T>(
  directory: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const guard = await acquireGuard(directory, signal);
  try {
    return await action();
  } finally {
    await removeOwnedLock(guard.file, guard.token);
  }
}

async function acquireDevicePairingLock(
  directory: string,
  signal?: AbortSignal,
): Promise<AcquiredDevicePairingLock> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = lockPath(directory);
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
      async () => {
        if (!(await lockIsStale(file, DEVICE_PAIRING_LOCK_MAX_AGE_MS))) {
          return false;
        }
        await rm(file, { force: true });
        return true;
      },
      signal,
    );
    if (reclaimed) continue;
    await delay(
      DEVICE_PAIRING_LOCK_POLL_MS,
      undefined,
      signal ? { signal } : undefined,
    );
  }
}

export async function withDevicePairingLease<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
  directory = updateRuntimeDirectory(),
): Promise<T> {
  const lock = await acquireDevicePairingLock(directory, signal);
  try {
    return await action();
  } finally {
    await withGuard(directory, async () => await removeOwnedLock(lock.file, lock.token));
  }
}
