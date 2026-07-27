import { randomUUID } from "node:crypto";
import type { WorkerJob, WorkerResult } from "@glossa/protocol";

const WORKER_STALE_MS = 45_000;

interface ConnectedWorker {
  accountId: string;
  deviceId: string;
  deviceName: string;
  workerId: string;
  generation: string;
  commandProgress: boolean;
  lastSeenAt: number;
  pendingJobs: WorkerJob[];
  pollWaiter?: (job: WorkerJob | null) => void;
}

interface ResultWaiter {
  accountId: string;
  workerId: string;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}


export class RouterState {
  readonly #workers = new Map<string, ConnectedWorker>();
  readonly #results = new Map<string, ResultWaiter>();

  register(
    accountId: string,
    deviceId: string,
    deviceName: string,
    workerId: string,
    capabilities: { commandProgress: boolean } = { commandProgress: false },
  ): string {
    this.#pruneStaleWorkers();
    const generation = randomUUID();
    const previous = this.#workers.get(workerId);
    if (
      previous &&
      (previous.accountId !== accountId || previous.deviceId !== deviceId)
    ) {
      throw new Error("worker_identity_conflict");
    }
    previous?.pollWaiter?.(null);
    this.#rejectWorkerWaiters(workerId);
    this.#workers.set(workerId, {
      accountId,
      deviceId,
      deviceName,
      workerId,
      generation,
      commandProgress: capabilities.commandProgress === true,
      lastSeenAt: Date.now(),
      pendingJobs: [],
    });
    return generation;
  }

  unregisterWorker(accountId: string, deviceId: string, workerId: string): void {
    const worker = this.#workers.get(workerId);
    if (
      !worker ||
      worker.accountId !== accountId ||
      worker.deviceId !== deviceId
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

    const waitingPoll = worker.pollWaiter;
    if (waitingPoll) waitingPoll(job);
    else worker.pendingJobs.push(job);

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
    return [...this.#workers.values()].filter(
      (worker) =>
        worker.accountId === accountId && worker.deviceId === deviceId,
    ).length;
  }

  supportsCommandProgress(accountId: string, workerId: string): boolean {
    this.#pruneStaleWorkers();
    const worker = this.#workers.get(workerId);
    return worker?.accountId === accountId && worker.commandProgress;
  }

  #pruneStaleWorkers(): void {
    const staleBefore = Date.now() - WORKER_STALE_MS;
    for (const worker of [...this.#workers.values()]) {
      if (worker.lastSeenAt < staleBefore) {
        this.#removeWorker(worker);
      }
    }
  }

  #removeWorker(worker: ConnectedWorker): void {
    worker.pollWaiter?.(null);
    this.#workers.delete(worker.workerId);
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
