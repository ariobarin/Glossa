import { randomUUID } from "node:crypto";
import {
  workerJobSchema,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";

const WORKER_REQUEST_TIMEOUT_MS = 19_000;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const WORKER_TOKEN_PATTERN = /^glw_[A-Za-z0-9_-]{43}$/;

interface RegisteredSession {
  generation: string;
  legacyRelay: boolean;
  workerToken?: string;
}

type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface WorkerHandler {
  handle(job: WorkerJob): Promise<WorkerResult>;
}

export interface RemoteWorkerOptions {
  origin: string;
  deviceToken: string;
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
  | { state: "connected"; reconnected: boolean; legacyRelay: boolean }
  | { state: "retrying"; error: Error; retryInMs: number }
  | { state: "disconnected" };

export class DeviceRejectedError extends Error {
  constructor() {
    super("The relay rejected the device credential.");
    this.name = "DeviceRejectedError";
  }
}

class RelayResponseError extends Error {
  constructor(readonly status: number) {
    super(`The relay returned HTTP ${status}.`);
    this.name = "RelayResponseError";
  }
}

function optionalWorkerToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORKER_TOKEN_PATTERN.test(value)) {
    throw new Error("The relay returned an invalid worker credential.");
  }
  return value;
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
            legacyRelay: session.legacyRelay,
          });
          connectedBefore = true;
          failures = 0;
          await this.#pollGeneration(session);
        } catch (error) {
          if (this.#signal.aborted) return;
          if (error instanceof DeviceRejectedError) throw error;
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
    let response: Response;
    try {
      response = await this.#post("/device/register", {
        workerId: this.#workerId,
        capabilities: { commandProgress: true },
      });
    } catch (error) {
      if (!(error instanceof RelayResponseError) || error.status !== 400) {
        throw error;
      }
      try {
        response = await this.#post("/device/register", {
          workerId: this.#workerId,
        });
      } catch (currentError) {
        if (
          !(currentError instanceof RelayResponseError) ||
          currentError.status !== 400
        ) {
          throw currentError;
        }
        response = await this.#post("/device/register", {});
        const legacyValue = (await response.json()) as unknown;
        if (
          typeof legacyValue !== "object" ||
          legacyValue === null ||
          !("generation" in legacyValue) ||
          typeof legacyValue.generation !== "string"
        ) {
          throw new Error("The relay returned an invalid registration response.");
        }
        const workerToken = "workerToken" in legacyValue
          ? optionalWorkerToken(legacyValue.workerToken)
          : undefined;
        return {
          generation: legacyValue.generation,
          legacyRelay: true,
          ...(workerToken ? { workerToken } : {}),
        };
      }
    }
    const value = (await response.json()) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("generation" in value) ||
      typeof value.generation !== "string" ||
      !("workerId" in value) ||
      value.workerId !== this.#workerId
    ) {
      throw new Error("The relay returned an invalid registration response.");
    }
    const workerToken = "workerToken" in value
      ? optionalWorkerToken(value.workerToken)
      : undefined;
    return {
      generation: value.generation,
      legacyRelay: false,
      ...(workerToken ? { workerToken } : {}),
    };
  }

  async #pollGeneration(session: RegisteredSession): Promise<void> {
    while (!this.#signal.aborted) {
      const response = await this.#post(
        "/device/poll",
        session.legacyRelay
          ? { generation: session.generation }
          : { workerId: this.#workerId, generation: session.generation },
        session.workerToken,
      );
      if (response.status === 204) continue;
      const value = (await response.json()) as unknown;
      const parsed = workerJobSchema.safeParse(
        typeof value === "object" && value !== null && "job" in value
          ? value.job
          : undefined,
      );
      if (!parsed.success) {
        throw new Error("The relay returned an invalid worker job.");
      }
      const heartbeat = session.legacyRelay
        ? undefined
        : setInterval(() => {
            void this.#post(
              "/device/heartbeat",
              {
                workerId: this.#workerId,
                generation: session.generation,
              },
              session.workerToken,
            ).catch(() => {});
          }, this.#heartbeatMs);
      heartbeat?.unref();
      let result: WorkerResult;
      try {
        result = await this.#worker.handle(parsed.data);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      await this.#post(
        "/device/result",
        session.legacyRelay ? result : { workerId: this.#workerId, result },
        session.workerToken,
      );
    }
  }

  async #unregister(session?: RegisteredSession): Promise<void> {
    const unregister = async (
      authorization: string,
    ): Promise<"accepted" | "rejected" | "unreachable"> => {
      try {
        const response = await this.#fetcher(
          new URL("/device/unregister", this.#origin),
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify({ workerId: this.#workerId }),
            signal: AbortSignal.timeout(3_000),
          },
        );
        if (response.ok) return "accepted";
        return [400, 401, 404, 409].includes(response.status)
          ? "rejected"
          : "unreachable";
      } catch {
        return "unreachable";
      }
    };

    if (!session?.workerToken) {
      await unregister(`Device ${this.#deviceToken}`);
      return;
    }
    const result = await unregister(`Worker ${session.workerToken}`);
    if (result === "rejected") {
      await unregister(`Device ${this.#deviceToken}`);
    }
    // Liveness expiry removes workers after abrupt or offline shutdowns.
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
