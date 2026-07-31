import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDirectory } from "./secure-store.js";

const UPDATE_LOCK_FILE = "update.lock";
const SESSION_SUFFIX = ".session";

export function updateRuntimeDirectory(): string {
  return path.join(configDirectory(), "runtime");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockOwner(lockFile: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function updateLockIsActive(directory: string): Promise<boolean> {
  const lockFile = path.join(directory, UPDATE_LOCK_FILE);
  try {
    const pid = await lockOwner(lockFile);
    if (pid !== null && processIsAlive(pid)) return true;
    await rm(lockFile, { force: true });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function activeSessionFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const active: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SESSION_SUFFIX)) continue;
    const pid = Number.parseInt(entry.name.split("-", 1)[0] ?? "", 10);
    const file = path.join(directory, entry.name);
    if (processIsAlive(pid)) active.push(file);
    else await rm(file, { force: true });
  }
  return active;
}

async function createUpdateLock(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, UPDATE_LOCK_FILE);
  const content = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  try {
    await writeFile(lockFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return lockFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (await updateLockIsActive(directory)) {
    throw new Error("Another Glossa update is already running.");
  }
  await writeFile(lockFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return lockFile;
}

export async function withUpdateLease<T>(
  action: () => Promise<T>,
  directory = updateRuntimeDirectory(),
): Promise<T> {
  const lockFile = await createUpdateLock(directory);
  try {
    if ((await activeSessionFiles(directory)).length > 0) {
      throw new Error("Disconnect every running Glossa workspace before updating.");
    }
    return await action();
  } finally {
    await rm(lockFile, { force: true });
  }
}

export async function withWorkspaceLease<T>(
  action: () => Promise<T>,
  directory = updateRuntimeDirectory(),
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await updateLockIsActive(directory)) {
    throw new Error("Glossa is updating. Run this workspace again after the update finishes.");
  }

  const leaseFile = path.join(
    directory,
    `${process.pid}-${randomUUID()}${SESSION_SUFFIX}`,
  );
  await writeFile(
    leaseFile,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  try {
    if (await updateLockIsActive(directory)) {
      throw new Error("Glossa is updating. Run this workspace again after the update finishes.");
    }
    return await action();
  } finally {
    await rm(leaseFile, { force: true });
  }
}
