import { randomUUID } from "node:crypto";
import {
  workerJobSchema,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";

const WORKER_REQUEST_TIMEOUT_MS = 19_000;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const CAPACITY_REFRESH_POLL_MS = 1;
const MAX_CONCURRENT_JOBS = 6;
const MAX_CONCURRENT_STATUS_JOBS = 2;
const WORKER_TOKEN_PATTERN = /^glw_[A-Za-z0-9_-]{43}$/;
const LEGACY_WORKER_CAPABILITIES = {
  commandProgress: true,
  concurrentJobs: true,
  structuredReads: true,
  structuredMutations: true,
  commandOutputRanges: true,
} as const;
const WORKER_CAPABILITIES = {
  ...LEGACY_WORKER_CAPABILITIES,
  imageReads: true,
} as const;

interface RegisteredSession {
  generation: string;
  workerToken: string;
  imageReads: boolean;
  mcpContractVersion?: string;
}

type JobLane = "status" | "cancel" | "read" | "mutation";

type LaneCounts = Record<JobLane, number>;

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface WorkerHandler {
  handle(job: WorkerJob): Promise<WorkerResult>;
}

export interface RemoteWorkerOptions {
  origin: string;
  deviceToken: string;
  accessProfile?: WorkerAccessProfile;
  workspaceLabel?: string;
  workerVersion?: string;
  worker: WorkerHandler;
  signal: AbortSignal;
  fetcher?: Fetcher;
  sleep?: Sleeper;
  random?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
  onStatus?: (status: RemoteWorkerStatus) => void;
}

export type RemoteWorkerStatus =
  | { state: "connecting" }
  | {
      state: "connected";
      reconnected: boolean;
      mcpContractVersion?: string;
    }
  | { state: "retrying"; error: Error; retryInMs: number }
  | { state: "disconnected" };

export class DeviceRejectedError extends Error {
  constructor() {
    super("The relay rejected the device credential.");
    this.name = "DeviceRejectedError";
  }
}

export class RelayProtocolUnsupportedError extends Error {
  constructor() {
    super(
      "The relay does not support this Glossa worker protocol. Update the relay before reconnecting this workspace.",
    );
    this.name = "RelayProtocolUnsupportedError";
  }
}

class RelayResponseError extends Error {
  constructor(readonly status: number) {
    super(`The relay returned HTTP ${status}.`);
    this.name = "RelayResponseError";
  }
}

function requiredWorkerToken(value: unknown): string {
  if (typeof value !== "string" || !WORKER_TOKEN_PATTERN.test(value)) {
    throw new Error("The relay returned an invalid worker credential.");
  }
  return value;
}

function acceptsCapabilities(
  value: unknown,
  requireImageReads: boolean,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("capabilities" in value)) return false;
  const capabilities = value.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const required = Object.keys(LEGACY_WORKER_CAPABILITIES);
  if (
    !required.every(
      (capability) =>
        (capabilities as Record<string, unknown>)[capability] === true,
    )
  ) {
    return false;
  }
  return !requireImageReads ||
    (capabilities as Record<string, unknown>).imageReads === true;
}

function jobLane(job: WorkerJob): JobLane {
  switch (job.type) {
    case "get_command":
    case "read_command_output":
      return "status";
    case "cancel_command":
      return "cancel";
    case "read_file":
    case "view_image":
    case "list_files":
    case "search_text":
    case "read_file_range":
      return "read";
    case "write_file":
    case "edit_file":
    case "make_directory":
    case "delete_path":
    case "move_path":
    case "run_command":
      return "mutation";
  }
}

function acceptedJobTypes(
  counts: LaneCounts,
  total: number,
  imageReads: boolean,
): WorkerJob["type"][] {
  if (total >= MAX_CONCURRENT_JOBS) return [];
  const accepted: WorkerJob["type"][] = [];
  if (counts.status < MAX_CONCURRENT_STATUS_JOBS) {
    accepted.push("get_command", "read_command_output");
  }
  if (counts.cancel < 1) accepted.push("cancel_command");
  if (counts.read < 2) {
    accepted.push("read_file");
    if (imageReads) accepted.push("view_image");
    accepted.push("list_files", "search_text", "read_file_range");
  }
  if (counts.mutation < 1) {
    accepted.push(
      "write_file",
      "edit_file",
      "make_directory",
      "delete_path",
      "move_path",
      "run_command",
    );
  }
  return accepted;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function reconnectDelayMs(
  failureCount: number,
  random: () => number,
  baseMs = DEFAULT_RECONNECT_BASE_MS,
  maximumMs = DEFAULT_RECONNECT_MAX_MS,
): number {
  const ceiling = Math.min(maximumMs, baseMs * 2 ** Math.min(failureCount, 8));
  return Math.floor(ceiling * (0.5 + random() * 0.5));
}

export class RemoteWorker {
  readonly #origin: URL;
  readonly #deviceToken: string;
  readonly #accessProfile: WorkerAccessProfile;
  readonly #workspaceLabel: string | undefined;
  readonly #workerVersion: string | undefined;
  readonly #worker: WorkerHandler;
  readonly #signal: AbortSignal;
  readonly #fetcher: Fetcher;
  readonly #sleep: Sleeper;
  readonly #random: () => number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #heartbeatMs: number;
  readonly #workerId = randomUUID();
  readonly #onStatus: (status: RemoteWorkerStatus) => void;

  constructor(options: RemoteWorkerOptions) {
    this.#origin = new URL(options.origin);
    this.#deviceToken = options.deviceToken;
    this.#accessProfile = options.accessProfile ?? "workspace";
    this.#workspaceLabel = options.workspaceLabel;
    this.#workerVersion = options.workerVersion;
    this.#worker = options.worker;
    this.#signal = options.signal;
    this.#fetcher = options.fetcher ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#reconnectBaseMs =
      options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#onStatus = options.onStatus ?? (() => {});
  }

  async run(): Promise<void> {
    let failures = 0;
    let connectedBefore = false;
    let registeredSession: RegisteredSession | undefined;
    this.#onStatus({ state: "connecting" });
    try {
      while (!this.#signal.aborted) {
        try {
          const session = await this.#register();
          registeredSession = session;
          this.#onStatus({
            state: "connected",
            reconnected: connectedBefore,
            ...(session.mcpContractVersion
              ? { mcpContractVersion: session.mcpContractVersion }
              : {}),
          });
          connectedBefore = true;
          failures = 0;
          await this.#pollGeneration(session);
        } catch (error) {
          if (this.#signal.aborted) return;
          if (
            error instanceof DeviceRejectedError ||
            error instanceof RelayProtocolUnsupportedError
          ) {
            throw error;
          }
          const delay = reconnectDelayMs(
            failures,
            this.#random,
            this.#reconnectBaseMs,
            this.#reconnectMaxMs,
          );
          failures += 1;
          this.#onStatus({
            state: "retrying",
            error: error instanceof Error ? error : new Error(String(error)),
            retryInMs: delay,
          });
          try {
            await this.#sleep(delay, this.#signal);
          } catch (sleepError) {
            if (this.#signal.aborted) return;
            throw sleepError;
          }
        }
      }
    } finally {
      await this.#unregister(registeredSession);
      this.#onStatus({ state: "disconnected" });
    }
  }

  async #register(): Promise<RegisteredSession> {
    const registrationBody = (capabilities: Record<string, true>) => ({
      workerId: this.#workerId,
      accessProfile: this.#accessProfile,
      ...(this.#workerVersion ? { workerVersion: this.#workerVersion } : {}),
      ...(this.#workspaceLabel ? { workspaceLabel: this.#workspaceLabel } : {}),
      capabilities,
    });

    let response: Response;
    let imageReads = true;
    try {
      response = await this.#post(
        "/device/register",
        registrationBody(WORKER_CAPABILITIES),
      );
    } catch (error) {
      if (!(error instanceof RelayResponseError) || error.status !== 400) {
        throw error;
      }
      imageReads = false;
      try {
        response = await this.#post(
          "/device/register",
          registrationBody(LEGACY_WORKER_CAPABILITIES),
        );
      } catch (legacyError) {
        if (
          legacyError instanceof RelayResponseError &&
          legacyError.status === 400
        ) {
          throw new RelayProtocolUnsupportedError();
        }
        throw legacyError;
      }
    }

    const value = (await response.json()) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("generation" in value) ||
      typeof value.generation !== "string" ||
      !("workerId" in value) ||
      value.workerId !== this.#workerId ||
      !("workerToken" in value) ||
      !("accessProfile" in value) ||
      value.accessProfile !== this.#accessProfile ||
      !acceptsCapabilities(value, imageReads) ||
      (this.#workspaceLabel !== undefined &&
        (!("workspaceLabel" in value) ||
          value.workspaceLabel !== this.#workspaceLabel))
    ) {
      throw new RelayProtocolUnsupportedError();
    }
    const mcpContractVersion = "mcpContractVersion" in value &&
        typeof value.mcpContractVersion === "string" &&
        value.mcpContractVersion.length > 0 &&
        value.mcpContractVersion.length <= 32
      ? value.mcpContractVersion
      : undefined;
    return {
      generation: value.generation,
      workerToken: requiredWorkerToken(value.workerToken),
      imageReads,
      ...(mcpContractVersion ? { mcpContractVersion } : {}),
    };
  }

  async #pollGeneration(session: RegisteredSession): Promise<void> {
    await this.#pollConcurrently(session);
  }

  async #pollConcurrently(session: RegisteredSession): Promise<void> {
    const counts: LaneCounts = {
      status: 0,
      cancel: 0,
      read: 0,
      mutation: 0,
    };
    const inFlight = new Set<Promise<void>>();
    const capacityWaiters = new Set<() => void>();
    let capacityVersion = 0;
    let failure: unknown;
    let heartbeat: NodeJS.Timeout | undefined;

    const stopHeartbeat = (): void => {
      if (!heartbeat) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const ensureHeartbeat = (): void => {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        void this.#post(
          "/device/heartbeat",
          { workerId: this.#workerId, generation: session.generation },
          session.workerToken,
        ).catch(() => {});
      }, this.#heartbeatMs);
      heartbeat.unref();
    };
    const signalCapacityChange = (): void => {
      capacityVersion += 1;
      const waiters = [...capacityWaiters];
      capacityWaiters.clear();
      for (const waiter of waiters) waiter();
    };
    const waitForCapacityChange = (
      afterVersion: number,
    ): { promise: Promise<void>; cancel: () => void } => {
      if (capacityVersion !== afterVersion) {
        return { promise: Promise.resolve(), cancel: () => {} };
      }
      let resolve!: () => void;
      const promise = new Promise<void>((complete) => {
        resolve = complete;
        capacityWaiters.add(resolve);
      });
      return {
        promise,
        cancel() {
          capacityWaiters.delete(resolve);
        },
      };
    };
    const dispatch = (job: WorkerJob): void => {
      const lane = jobLane(job);
      counts[lane] += 1;
      ensureHeartbeat();
      let task!: Promise<void>;
      task = this.#handleAndPost(session, job)
        .catch((error: unknown) => {
          failure ??= error;
        })
        .finally(() => {
          counts[lane] -= 1;
          inFlight.delete(task);
          signalCapacityChange();
          if (inFlight.size === 0) stopHeartbeat();
        });
      inFlight.add(task);
    };

    try {
      while (!this.#signal.aborted) {
        if (failure !== undefined) throw failure;
        const acceptedTypes = acceptedJobTypes(
          counts,
          inFlight.size,
          session.imageReads,
        );
        if (acceptedTypes.length === 0) {
          await Promise.race(inFlight);
          continue;
        }
        let observedCapacityVersion = capacityVersion;
        const poll = this.#pollForJob(session, acceptedTypes);
        while (!this.#signal.aborted) {
          const capacityChange = waitForCapacityChange(observedCapacityVersion);
          const outcome = await Promise.race([
            poll.then((job) => ({ kind: "poll" as const, job })),
            capacityChange.promise.then(() => ({ kind: "capacity" as const })),
          ]);
          capacityChange.cancel();
          if (outcome.kind === "poll") {
            const job = outcome.job;
            if (job) {
              if (!acceptedTypes.includes(job.type)) {
                throw new Error("The relay delivered a job outside worker capacity.");
              }
              dispatch(job);
            }
            break;
          }

          if (failure !== undefined) throw failure;
          observedCapacityVersion = capacityVersion;
          const refreshedTypes = acceptedJobTypes(
            counts,
            inFlight.size,
            session.imageReads,
          );
          const newlyAcceptedTypes = refreshedTypes.filter(
            (type) => !acceptedTypes.includes(type),
          );
          if (newlyAcceptedTypes.length === 0) continue;

          const refreshedJob = await this.#pollForJob(
            session,
            newlyAcceptedTypes,
            CAPACITY_REFRESH_POLL_MS,
          );
          if (refreshedJob) {
            if (!newlyAcceptedTypes.includes(refreshedJob.type)) {
              throw new Error("The relay delivered a job outside worker capacity.");
            }
            dispatch(refreshedJob);
            observedCapacityVersion = capacityVersion;
            continue;
          }

          const staleJob = await poll;
          if (staleJob) {
            if (!acceptedTypes.includes(staleJob.type)) {
              throw new Error("The relay delivered a job outside worker capacity.");
            }
            dispatch(staleJob);
          }
          break;
        }
      }
    } finally {
      stopHeartbeat();
      for (const waiter of capacityWaiters) waiter();
      capacityWaiters.clear();
      await Promise.allSettled(inFlight);
    }
    if (failure !== undefined) throw failure;
  }

  async #pollForJob(
    session: RegisteredSession,
    acceptedTypes?: WorkerJob["type"][],
    waitMs?: number,
  ): Promise<WorkerJob | null> {
    const response = await this.#post(
      "/device/poll",
      {
        workerId: this.#workerId,
        generation: session.generation,
        ...(acceptedTypes ? { acceptedTypes } : {}),
        ...(waitMs === undefined ? {} : { waitMs }),
      },
      session.workerToken,
    );
    if (response.status === 204) return null;
    const value = (await response.json()) as unknown;
    const parsed = workerJobSchema.safeParse(
      typeof value === "object" && value !== null && "job" in value
        ? value.job
        : undefined,
    );
    if (!parsed.success) {
      throw new Error("The relay returned an invalid worker job.");
    }
    return parsed.data;
  }

  async #handleAndPost(
    session: RegisteredSession,
    job: WorkerJob,
  ): Promise<void> {
    const result: WorkerResult = await this.#worker.handle(job);
    try {
      await this.#post(
        "/device/result",
        { workerId: this.#workerId, result },
        session.workerToken,
      );
    } catch (error) {
      if (error instanceof RelayResponseError && error.status === 410) return;
      throw error;
    }
  }

  async #unregister(session?: RegisteredSession): Promise<void> {
    if (!session) return;
    try {
      await this.#fetcher(new URL("/device/unregister", this.#origin), {
        method: "POST",
        headers: {
          authorization: `Worker ${session.workerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workerId: this.#workerId }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      // Liveness expiry removes workers after abrupt or offline shutdowns.
    }
  }

  async #post(
    path: string,
    body: unknown,
    workerToken?: string,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([this.#signal, timeout]);
    const response = await this.#fetcher(new URL(path, this.#origin), {
      method: "POST",
      headers: {
        authorization: workerToken
          ? `Worker ${workerToken}`
          : `Device ${this.#deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401 && !workerToken) throw new DeviceRejectedError();
    if (!response.ok) throw new RelayResponseError(response.status);
    return response;
  }
}
