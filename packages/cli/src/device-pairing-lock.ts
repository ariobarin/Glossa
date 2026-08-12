import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIsAlive, updateRuntimeDirectory } from "./update-lock.js";

const DEVICE_PAIRING_LOCK = "device-pairing.lock";
const DEVICE_PAIRING_LOCK_POLL_MS = 100;

interface DevicePairingLockOwner {
  pid: number;
  startedAt: string;
}

function lockPath(directory: string): string {
  return path.join(directory, DEVICE_PAIRING_LOCK);
}

async function lockIsStale(file: string): Promise<boolean> {
  let owner: DevicePairingLockOwner | undefined;
  try {
    owner = JSON.parse(await readFile(file, "utf8")) as DevicePairingLockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  if (!owner || !processIsAlive(owner.pid)) return true;
  return false;
}

async function acquireDevicePairingLock(
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = lockPath(directory);
  for (;;) {
    signal?.throwIfAborted();
    try {
      await writeFile(
        file,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await lockIsStale(file)) {
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

export async function withDevicePairingLease<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
  directory = updateRuntimeDirectory(),
): Promise<T> {
  const file = await acquireDevicePairingLock(directory, signal);
  try {
    return await action();
  } finally {
    await rm(file, { force: true });
  }
}
