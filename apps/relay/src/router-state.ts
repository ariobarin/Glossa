import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  workerJobAuthority,
  workerPermissions,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerPermissions,
  type WorkerResult,
} from "@glossa/protocol";

const WORKER_STALE_MS = 45_000;
const WORKER_PRUNE_INTERVAL_MS = 5_000;
const DEVICE_SEEN_PERSIST_MS = 60_000;
const WORKER_TOKEN_PATTERN = /^glw_[A-Za-z0-9_-]{43}$/;
export const CURRENT_WORKER_CAPABILITIES = {
  commandProgress: true,
  concurrentJobs: true,
  structuredReads: true,
  imageReads: true,
  structuredMutations: true,
  commandOutputRanges: true,
} as const;
export type WorkerCapabilities =
  Omit<typeof CURRENT_WORKER_CAPABILITIES, "imageReads"> & {
    imageReads: boolean;
  };

function workerTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function deviceKey(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

interface PollWaiter {
  acceptedTypes?: ReadonlySet<WorkerJob["type"]>;
  resolve: (job: WorkerJob | null) => void;
}

interface ConnectedWorker {
  accountId: string;
  deviceId: string;
  deviceName: string;
  workerId: string;
  generation: string;
  accessProfile: WorkerAccessProfile;
  workspaceLabel?: string;
  workerVersion?: string;
  capabilities: WorkerCapabilities;
  sessionDigest: string;
  lastSeenAt: number;
  pendingJobs: WorkerJob[];
  pollWaiter?: PollWaiter;
}

export interface WorkerSessionIdentity {
  accountId: string;
  deviceId: string;
  workerId: string;
  generation: string;
}

interface ResultWaiter {
  accountId: string;
  workerId: string;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class RevokedDeviceRegistrationError extends Error {
  constructor() {
    super("device_revoked");
    this.name = "RevokedDeviceRegistrationError";
  }
}

function jobPermissionError(
  worker: ConnectedWorker,
  job: WorkerJob,
):
  | "write_access_disabled"
  | "command_access_disabled"
  | "worker_protocol_unsupported"
  | null {
  if (job.type === "view_image" && !worker.capabilities.imageReads) {
    return "worker_protocol_unsupported";
  }
  const permissions = workerPermissions(worker.accessProfile);
  const authority = workerJobAuthority(job.type);
  if (authority === "write" && !permissions.writeFiles) {
    return "write_access_disabled";
  }
  if (authority === "command" && !permissions.runCommands) {
    return "command_access_disabled";
  }
  return null;
}


export class RouterState {
  readonly #workers = new Map<string, ConnectedWorker>();
  readonly #workerSessions = new Map<string, string>();
  readonly #workerCountsByDevice = new Map<string, number>();
  readonly #deviceSeenPersistedAt = new Map<string, number>();
  readonly #revokedDeviceIds = new Set<string>();
  readonly #results = new Map<string, ResultWaiter>();
  #lastPrunedAt = 0;

  register(
    accountId: string,
    deviceId: string,
    deviceName: string,
    workerId: string,
    options: {
      accessProfile: WorkerAccessProfile;
      workspaceLabel?: string;
      workerVersion?: string;
      capabilities?: WorkerCapabilities;
    } = { accessProfile: "system" },
  ): { generation: string; workerToken: string } {
    this.#pruneStaleWorkers();
    if (this.#revokedDeviceIds.has(deviceId)) {
      throw new RevokedDeviceRegistrationError();
    }
    const generation = randomUUID();
    const workerToken = `glw_${randomBytes(32).toString("base64url")}`;
    const sessionDigest = workerTokenDigest(workerToken);
    const previous = this.#workers.get(workerId);
    if (
      previous &&
      (previous.accountId !== accountId || previous.deviceId !== deviceId)
    ) {
      throw new Error("worker_identity_conflict");
    }
    previous?.pollWaiter?.resolve(null);
    if (previous) {
      this.#workerSessions.delete(previous.sessionDigest);
    }
    this.#rejectWorkerWaiters(workerId);
    if (!previous) {
      const key = deviceKey(accountId, deviceId);
      this.#workerCountsByDevice.set(
        key,
        (this.#workerCountsByDevice.get(key) ?? 0) + 1,
      );
    }
    this.#workers.set(workerId, {
      accountId,
      deviceId,
      deviceName,
      workerId,
      generation,
      accessProfile: options.accessProfile,
      capabilities: options.capabilities ?? CURRENT_WORKER_CAPABILITIES,
      ...(options.workerVersion ? { workerVersion: options.workerVersion } : {}),
      ...(options.workspaceLabel
        ? { workspaceLabel: options.workspaceLabel }
        : {}),
      sessionDigest,
      lastSeenAt: Date.now(),
      pendingJobs: [],
    });
    this.#workerSessions.set(sessionDigest, workerId);
    this.#deviceSeenPersistedAt.set(deviceKey(accountId, deviceId), Date.now());
    return { generation, workerToken };
  }

  authenticateWorkerToken(token: string): WorkerSessionIdentity | null {
    this.#pruneStaleWorkers();
    if (!WORKER_TOKEN_PATTERN.test(token)) return null;
    const sessionDigest = workerTokenDigest(token);
    const workerId = this.#workerSessions.get(sessionDigest);
    if (!workerId) return null;
    const worker = this.#workers.get(workerId);
    if (!worker || worker.sessionDigest !== sessionDigest) return null;
    return {
      accountId: worker.accountId,
      deviceId: worker.deviceId,
      workerId: worker.workerId,
      generation: worker.generation,
    };
  }

  claimDeviceSeenPersistence(
    accountId: string,
    deviceId: string,
  ): number | null {
    const key = deviceKey(accountId, deviceId);
    const now = Date.now();
    const persistedAt = this.#deviceSeenPersistedAt.get(key);
    if (persistedAt !== undefined && now - persistedAt < DEVICE_SEEN_PERSIST_MS) {
      return null;
    }
    this.#deviceSeenPersistedAt.set(key, now);
    return now;
  }

  releaseDeviceSeenPersistence(
    accountId: string,
    deviceId: string,
    claimedAt: number,
  ): void {
    const key = deviceKey(accountId, deviceId);
    if (this.#deviceSeenPersistedAt.get(key) === claimedAt) {
      this.#deviceSeenPersistedAt.delete(key);
    }
  }

  unregisterWorker(
    accountId: string,
    deviceId: string,
    workerId: string,
    generation?: string,
  ): void {
    const worker = this.#workers.get(workerId);
    if (
      !worker ||
      worker.accountId !== accountId ||
      worker.deviceId !== deviceId ||
      (generation !== undefined && worker.generation !== generation)
    ) {
      return;
    }
    this.#removeWorker(worker);
  }

  unregisterDevice(deviceId: string): void {
    this.#revokedDeviceIds.add(deviceId);
    for (const worker of [...this.#workers.values()]) {
      if (worker.deviceId === deviceId) {
        this.unregisterWorker(worker.accountId, worker.deviceId, worker.workerId);
      }
    }
  }

  async poll(
    accountId: string,
    deviceId: string,
    workerId: string,
    generation: string,
    timeoutMs: number,
    acceptedTypes?: ReadonlySet<WorkerJob["type"]>,
  ): Promise<WorkerJob | null> {
    const worker = this.#workers.get(workerId);
    if (
      !worker ||
      worker.accountId !== accountId ||
      worker.deviceId !== deviceId ||
      worker.generation !== generation
    ) {
      throw new Error("unknown_worker_generation");
    }
    worker.lastSeenAt = Date.now();

    const queuedIndex = worker.pendingJobs.findIndex(
      (job) => !acceptedTypes || acceptedTypes.has(job.type),
    );
    if (queuedIndex !== -1) {
      return worker.pendingJobs.splice(queuedIndex, 1)[0]!;
    }

    worker.pollWaiter?.resolve(null);
    return await new Promise((resolve) => {
      const waiter: PollWaiter = {
        ...(acceptedTypes ? { acceptedTypes } : {}),
        resolve(job) {
          clearTimeout(timer);
          if (worker.pollWaiter === waiter) delete worker.pollWaiter;
          resolve(job);
        },
      };
      const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
      worker.pollWaiter = waiter;
    });
  }

  heartbeat(
    accountId: string,
    deviceId: string,
    workerId: string,
    generation: string,
  ): boolean {
    const worker = this.#workers.get(workerId);
    if (
      !worker ||
      worker.accountId !== accountId ||
      worker.deviceId !== deviceId ||
      worker.generation !== generation
    ) {
      return false;
    }
    worker.lastSeenAt = Date.now();
    return true;
  }

  enqueue(
    accountId: string,
    workerId: string,
    job: WorkerJob,
    timeoutMs: number,
  ): Promise<WorkerResult> {
    this.#pruneStaleWorkers();
    const worker = this.#workers.get(workerId);
    if (!worker || worker.accountId !== accountId) {
      return Promise.reject(new Error("device_offline"));
    }
    const permissionError = jobPermissionError(worker, job);
    if (permissionError) {
      return Promise.reject(new Error(permissionError));
    }

    const waitingPoll = worker.pollWaiter;
    if (
      waitingPoll &&
      (
        !waitingPoll.acceptedTypes ||
        waitingPoll.acceptedTypes.has(job.type)
      )
    ) {
      waitingPoll.resolve(job);
    } else {
      worker.pendingJobs.push(job);
    }

    return new Promise((resolve, reject) => {
      const expiresAt = Date.now() + timeoutMs;
      const timer = setTimeout(() => {
        const pending = this.#results.get(job.requestId);
        if (!pending || pending.expiresAt !== expiresAt) return;
        this.#results.delete(job.requestId);
        const queuedIndex = worker.pendingJobs.findIndex(
          (queuedJob) => queuedJob.requestId === job.requestId,
        );
        if (queuedIndex !== -1) worker.pendingJobs.splice(queuedIndex, 1);
        reject(new Error("job_timeout"));
      }, timeoutMs);
      timer.unref();
      this.#results.set(job.requestId, {
        accountId,
        workerId,
        resolve,
        reject,
        expiresAt,
        timer,
      });
    });
  }

  complete(
    accountId: string,
    workerId: string,
    result: WorkerResult,
  ): boolean {
    const waiter = this.#results.get(result.requestId);
    if (
      !waiter ||
      waiter.accountId !== accountId ||
      waiter.workerId !== workerId
    ) {
      return false;
    }
    this.#results.delete(result.requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
    return true;
  }


  listDevices(accountId: string): Array<{
    deviceId: string;
    name: string;
    path: ".";
    workspaceLabel?: string;
    workerVersion?: string;
    accessProfile: WorkerAccessProfile;
    permissions: WorkerPermissions;
    capabilities: WorkerCapabilities;
  }> {
    this.#pruneStaleWorkers();
    return [...this.#workers.values()]
      .filter((worker) => worker.accountId === accountId)
      .map((worker) => ({
        deviceId: worker.workerId,
        name: worker.deviceName,
        path: ".",
        ...(worker.workerVersion ? { workerVersion: worker.workerVersion } : {}),
        accessProfile: worker.accessProfile,
        permissions: workerPermissions(worker.accessProfile),
        capabilities: worker.capabilities,
        ...(worker.workspaceLabel
          ? { workspaceLabel: worker.workspaceLabel }
          : {}),
      }));
  }

  activeWorkerCount(accountId: string, deviceId: string): number {
    this.#pruneStaleWorkers();
    return this.#workerCountsByDevice.get(deviceKey(accountId, deviceId)) ?? 0;
  }

  workerAccessProfile(
    accountId: string,
    workerId: string,
  ): WorkerAccessProfile | null {
    this.#pruneStaleWorkers();
    const worker = this.#workers.get(workerId);
    return worker?.accountId === accountId ? worker.accessProfile : null;
  }

  #pruneStaleWorkers(): void {
    const now = Date.now();
    const elapsed = now - this.#lastPrunedAt;
    if (elapsed >= 0 && elapsed < WORKER_PRUNE_INTERVAL_MS) return;
    this.#lastPrunedAt = now;
    const staleBefore = now - WORKER_STALE_MS;
    for (const worker of [...this.#workers.values()]) {
      if (worker.lastSeenAt < staleBefore) {
        this.#removeWorker(worker);
      }
    }
  }

  #removeWorker(worker: ConnectedWorker): void {
    worker.pollWaiter?.resolve(null);
    this.#workers.delete(worker.workerId);
    this.#workerSessions.delete(worker.sessionDigest);
    const key = deviceKey(worker.accountId, worker.deviceId);
    const remaining = (this.#workerCountsByDevice.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.#workerCountsByDevice.set(key, remaining);
    } else {
      this.#workerCountsByDevice.delete(key);
      this.#deviceSeenPersistedAt.delete(key);
    }
    this.#rejectWorkerWaiters(worker.workerId);
  }

  #rejectWorkerWaiters(workerId: string): void {
    for (const [requestId, waiter] of this.#results) {
      if (waiter.workerId !== workerId) continue;
      clearTimeout(waiter.timer);
      this.#results.delete(requestId);
      waiter.reject(new Error("device_offline"));
    }
  }

}
