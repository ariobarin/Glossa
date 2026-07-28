import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkerJob, WorkerResult } from "@glossa/protocol";

const WORKER_STALE_MS = 45_000;
const WORKER_PRUNE_INTERVAL_MS = 5_000;
const DEVICE_SEEN_PERSIST_MS = 60_000;
const WORKER_TOKEN_PATTERN = /^glw_[A-Za-z0-9_-]{43}$/;

function workerTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function deviceKey(accountId: string, deviceId: string): string {
  return `${accountId}:${deviceId}`;
}

interface ConnectedWorker {
  accountId: string;
  deviceId: string;
  deviceName: string;
  workerId: string;
  generation: string;
  commandProgress: boolean;
  sessionDigest: string;
  lastSeenAt: number;
  pendingJobs: WorkerJob[];
  pollWaiter?: (job: WorkerJob | null) => void;
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

function compatibleJob(worker: ConnectedWorker, job: WorkerJob): WorkerJob {
  if (
    job.type !== "get_command" ||
    job.afterSequence === undefined ||
    worker.commandProgress
  ) {
    return job;
  }
  const compatible = { ...job };
  delete compatible.afterSequence;
  return compatible;
}


export class RouterState {
  readonly #workers = new Map<string, ConnectedWorker>();
  readonly #workerSessions = new Map<string, string>();
  readonly #workerCountsByDevice = new Map<string, number>();
  readonly #deviceSeenPersistedAt = new Map<string, number>();
  readonly #results = new Map<string, ResultWaiter>();
  #lastPrunedAt = 0;

  register(
    accountId: string,
    deviceId: string,
    deviceName: string,
    workerId: string,
    capabilities: { commandProgress: boolean } = { commandProgress: false },
  ): { generation: string; workerToken: string } {
    this.#pruneStaleWorkers();
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
    previous?.pollWaiter?.(null);
    if (previous) this.#workerSessions.delete(previous.sessionDigest);
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
      commandProgress: capabilities.commandProgress === true,
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

    const queued = worker.pendingJobs.shift();
    if (queued) return queued;

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (worker.pollWaiter === waiter) delete worker.pollWaiter;
        resolve(null);
      }, timeoutMs);
      const waiter = (job: WorkerJob | null): void => {
        clearTimeout(timer);
        if (worker.pollWaiter === waiter) delete worker.pollWaiter;
        resolve(job);
      };
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

    const deliverableJob = compatibleJob(worker, job);
    const waitingPoll = worker.pollWaiter;
    if (waitingPoll) waitingPoll(deliverableJob);
    else worker.pendingJobs.push(deliverableJob);

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
  }> {
    this.#pruneStaleWorkers();
    return [...this.#workers.values()]
      .filter((worker) => worker.accountId === accountId)
      .map((worker) => ({
        deviceId: worker.workerId,
        name: worker.deviceName,
        path: ".",
      }));
  }

  activeWorkerCount(accountId: string, deviceId: string): number {
    this.#pruneStaleWorkers();
    return this.#workerCountsByDevice.get(deviceKey(accountId, deviceId)) ?? 0;
  }

  supportsCommandProgress(accountId: string, workerId: string): boolean {
    this.#pruneStaleWorkers();
    const worker = this.#workers.get(workerId);
    return worker?.accountId === accountId && worker.commandProgress;
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
    worker.pollWaiter?.(null);
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
