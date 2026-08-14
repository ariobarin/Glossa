import { createHash } from "node:crypto";
import { lstat, mkdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { accountHomeDirectory } from "./path-policy.js";

const GUARD_STALE_MS = 5_000;
const GUARD_RETRY_MS = 10;
const GUARD_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 250;

export class WorkspaceAlreadyActiveError extends Error {
  constructor() {
    super(
      "This workspace is already exposed by another Glossa process. Stop that process before starting another session for the same directory.",
    );
    this.name = "WorkspaceAlreadyActiveError";
  }
}

export interface WorkspaceLease {
  release(): Promise<void>;
}

export interface WorkspaceLeaseOptions {
  directory?: string;
}

function accountIdentity(): string {
  if (typeof process.getuid === "function") return `uid:${process.getuid()}`;
  return `home:${accountHomeDirectory().toLowerCase()}`;
}

function workspaceIdentity(root: string): string {
  const canonical = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256")
    .update(accountIdentity())
    .update("\0")
    .update(canonical)
    .digest("hex")
    .slice(0, 32);
}

function defaultLeaseDirectory(): string {
  if (typeof process.getuid === "function") {
    return path.join("/tmp", `glossa-workspaces-${process.getuid()}`);
  }
  return path.join(accountHomeDirectory(), ".glossa-workspace-leases");
}

async function ensureLeaseDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("The Glossa workspace lease location is not a private directory.");
  }
  if (typeof process.getuid === "function") {
    if (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0) {
      throw new Error(
        "The Glossa workspace lease directory must be owned by the current account and inaccessible to other accounts.",
      );
    }
  }
}

function endpointFor(identity: string, directory: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\glossa-workspace-${identity}`;
  }
  return path.join(directory, `${identity}.sock`);
}

async function acquireGuard(
  directory: string,
  identity: string,
): Promise<() => Promise<void>> {
  const guard = path.join(directory, `${identity}.guard`);
  const deadline = Date.now() + GUARD_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(guard, { mode: 0o700 });
      return async () => await rm(guard, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - (await stat(guard)).mtimeMs >= GUARD_STALE_MS;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (stale) {
        await rm(guard, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out while checking whether this workspace is already active.",
        );
      }
      await delay(GUARD_RETRY_MS);
    }
  }
}

function createLeaseServer(): net.Server {
  return net.createServer((socket) => socket.destroy());
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

async function endpointIsActive(endpoint: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function acquireWorkspaceLease(
  root: string,
  options: WorkspaceLeaseOptions = {},
): Promise<WorkspaceLease> {
  const userDirectory = options.directory ?? defaultLeaseDirectory();
  await ensureLeaseDirectory(userDirectory);
  const identity = workspaceIdentity(root);
  const endpoint = endpointFor(identity, userDirectory);
  const releaseGuard = await acquireGuard(userDirectory, identity);
  let server: net.Server | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      server = createLeaseServer();
      try {
        await listen(server, endpoint);
        server.unref();
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            await ensureLeaseDirectory(userDirectory);
            const releaseGuard = await acquireGuard(userDirectory, identity);
            try {
              await closeServer(server!);
              if (process.platform !== "win32") {
                await rm(endpoint, { force: true });
              }
            } finally {
              await releaseGuard();
            }
          },
        };
      } catch (error) {
        await closeServer(server);
        if (await endpointIsActive(endpoint)) {
          throw new WorkspaceAlreadyActiveError();
        }
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        if (process.platform !== "win32") await rm(endpoint, { force: true });
      }
    }
    throw new Error("Could not reserve this workspace for the current Glossa process.");
  } finally {
    await releaseGuard();
  }
}
