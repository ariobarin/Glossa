import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { configDirectory } from "./secure-store.js";

const UPDATE_SUFFIX = ".update";
const SESSION_SUFFIX = ".session";
const execFileAsync = promisify(execFile);
const ownProcessStartedAt = Date.now() - process.uptime() * 1000;

export function updateRuntimeDirectory(): string {
  return path.join(configDirectory(), "runtime");
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function leasePid(name: string, suffix: string): number | null {
  if (!name.endsWith(suffix)) return null;
  const separator = name.indexOf("-");
  if (separator <= 0) return null;
  const pid = Number(name.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function leasePredatesProcess(file: string, pid: number): Promise<boolean> {
  try {
    const lease = JSON.parse(await readFile(file, "utf8")) as { startedAt?: unknown };
    if (typeof lease.startedAt !== "string") return false;
    const leaseStartedAt = Date.parse(lease.startedAt);
    if (!Number.isFinite(leaseStartedAt)) return false;
    if (pid === process.pid) return ownProcessStartedAt > leaseStartedAt;

    const windows = process.platform === "win32";
    const executable = windows
      ? path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      )
      : "ps";
    const args = windows
      ? [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ]
      : ["-o", "lstart=", "-p", String(pid)];
    const { stdout } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: "C" },
    });
    return Date.parse(stdout.trim()) > leaseStartedAt;
  } catch {
    // Keep the lease if its owner cannot be verified.
    return false;
  }
}

async function activeLeaseFiles(
  directory: string,
  suffix: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const active: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
    const pid = leasePid(entry.name, suffix);
    const file = path.join(directory, entry.name);
    if (pid !== null && processIsAlive(pid) && !(await leasePredatesProcess(file, pid))) {
      active.push(file);
    } else {
      await rm(file, { force: true });
    }
  }
  return active;
}

async function updateLockIsActive(directory: string): Promise<boolean> {
  return (await activeLeaseFiles(directory, UPDATE_SUFFIX)).length > 0;
}

async function activeSessionFiles(directory: string): Promise<string[]> {
  return await activeLeaseFiles(directory, SESSION_SUFFIX);
}

async function createUpdateLock(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(
    directory,
    `${process.pid}-${randomUUID()}${UPDATE_SUFFIX}`,
  );
  const content = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  await writeFile(lockFile, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  try {
    const contenders = await activeLeaseFiles(directory, UPDATE_SUFFIX);
    if (contenders.some((file) => file !== lockFile)) {
      throw new Error("Another Glossa update is already running.");
    }
    return lockFile;
  } catch (error) {
    await rm(lockFile, { force: true });
    throw error;
  }
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
