import {
  containsRestrictedAuthenticationData,
  DEFAULT_WORKER_ACCESS_PROFILE,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import { announceConnectHint, connectHintStore, shouldShowConnectHint } from "../first-run.js";
import {
  deleteDeviceCredential,
  loadDeviceCredential,
  saveDeviceCredential,
  type StoredDeviceCredential,
} from "../device-store.js";
import { withDevicePairingLease } from "../device-pairing-lock.js";
import { pairDevice } from "../device-pairing.js";
import {
  revokePairedDevice,
  type RelayEndpoints,
} from "../relay-client.js";
import {
  LocalWorker,
  type CommandAuthorizer,
} from "./local-worker.js";
import {
  DeviceRejectedError,
  RemoteWorker,
  type WorkerHandler,
  type RemoteWorkerStatus,
} from "./remote-worker.js";

export type ManagedSessionEvent =
  | {
      type: "session";
      root: string;
      deviceName: string;
      accessProfile: WorkerAccessProfile;
    }
  | { type: "status"; status: RemoteWorkerStatus }
  | { type: "activity"; phase: "started"; job: WorkerJob }
  | { type: "activity"; phase: "returned"; job: WorkerJob; ok: boolean }
  | { type: "notice"; message: string; persistAfterExit?: boolean };

export interface ManagedSessionOptions {
  signal?: AbortSignal;
  onEvent?: (event: ManagedSessionEvent) => void;
  quiet?: boolean;
  handleProcessSignals?: boolean;
  device?: StoredDeviceCredential;
  accessProfile?: WorkerAccessProfile;
  workspaceLabel?: string;
  workerVersion?: string;
  authorizeCommand?: CommandAuthorizer;
}

function report(
  options: ManagedSessionOptions,
  event: ManagedSessionEvent,
  message: string,
): void {
  options.onEvent?.(event);
  if (!options.quiet) console.error(message);
}

function activityResultLabel(
  job: WorkerJob,
  result: WorkerResult,
): string {
  if (!result.ok) return `${job.type} failed`;
  if (
    job.type === "run_command" &&
    result.value &&
    typeof result.value === "object" &&
    "status" in result.value &&
    result.value.status === "running"
  ) {
    return "run_command started";
  }
  return `${job.type} completed`;
}

function activitySafeJob(job: WorkerJob): WorkerJob {
  if (!containsRestrictedAuthenticationData(job)) return job;

  switch (job.type) {
    case "read_file":
    case "view_image":
      return { ...job, path: "[restricted input blocked]" };
    case "list_files":
      return {
        ...job,
        path: "[restricted input blocked]",
        cursor: undefined,
      };
    case "search_text":
      return {
        ...job,
        query: "[restricted input blocked]",
        path: undefined,
        extensions: undefined,
      };
    case "read_file_range":
      return { ...job, path: "[restricted input blocked]" };
    case "write_file":
      return {
        ...job,
        path: "[restricted input blocked]",
        content: "[restricted input blocked]",
      };
    case "edit_file":
      return {
        ...job,
        path: "[restricted input blocked]",
        edits: [{
          oldText: "[restricted input blocked]",
          newText: "",
        }],
      };
    case "make_directory":
    case "delete_path":
      return { ...job, path: "[restricted input blocked]" };
    case "move_path":
      return {
        ...job,
        source: "[restricted input blocked]",
        destination: "[restricted input blocked]",
      };
    case "run_command":
      return {
        type: "run_command",
        requestId: job.requestId,
        argv: ["[restricted input blocked]"],
        timeoutMs: job.timeoutMs,
        ...(job.waitMs === undefined ? {} : { waitMs: job.waitMs }),
      };
    case "get_command":
    case "read_command_output":
    case "cancel_command":
      return job;
  }
}

export function visibleWorker(
  worker: WorkerHandler,
  options: ManagedSessionOptions,
): WorkerHandler {
  return {
    async handle(job: WorkerJob): Promise<WorkerResult> {
      const visibleJob = activitySafeJob(job);
      options.onEvent?.({ type: "activity", phase: "started", job: visibleJob });
      try {
        const result = await worker.handle(job);
        report(
          options,
          {
            type: "activity",
            phase: "returned",
            job: visibleJob,
            ok: result.ok,
          },
          `${activityResultLabel(job, result)} (${job.requestId}).`,
        );
        return result;
      } catch (error) {
        report(
          options,
          {
            type: "activity",
            phase: "returned",
            job: visibleJob,
            ok: false,
          },
          `${job.type} failed (${job.requestId}).`,
        );
        throw error;
      }
    },
  };
}

export interface ManagedDeviceDependencies {
  loadDeviceCredential?: typeof loadDeviceCredential;
  deleteDeviceCredential?: typeof deleteDeviceCredential;
  saveDeviceCredential?: typeof saveDeviceCredential;
  pairDevice?: typeof pairDevice;
  revokePairedDevice?: typeof revokePairedDevice;
  withDevicePairingLease?: <T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
}

export async function deviceForSession(
  endpoints: RelayEndpoints,
  dependencies: ManagedDeviceDependencies = {},
  signal?: AbortSignal,
): Promise<StoredDeviceCredential> {
  const loadDevice = dependencies.loadDeviceCredential ?? loadDeviceCredential;
  const removeDevice = dependencies.deleteDeviceCredential ?? deleteDeviceCredential;
  const saveDevice = dependencies.saveDeviceCredential ?? saveDeviceCredential;
  const pair = dependencies.pairDevice ?? pairDevice;
  const revoke = dependencies.revokePairedDevice ?? revokePairedDevice;
  const withPairingLease = dependencies.withDevicePairingLease ?? withDevicePairingLease;

  signal?.throwIfAborted();
  const stored = await loadDevice();
  if (stored?.relayOrigin === endpoints.relayOrigin) return stored;

  return await withPairingLease(async () => {
    signal?.throwIfAborted();
    const current = await loadDevice();
    if (current?.relayOrigin === endpoints.relayOrigin) return current;
    if (current) {
      await revoke({ relayOrigin: current.relayOrigin }, current);
      await removeDevice();
    }

    signal?.throwIfAborted();
    const paired = await pair(endpoints, signal);
    await saveDevice(paired);
    return paired;
  }, signal);
}

function retryMessage(retryInMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryInMs / 1_000));
  return `Retrying in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

export function accessProfileSummary(
  accessProfile: WorkerAccessProfile,
): string {
  switch (accessProfile) {
    case "read-only":
      return "Read-only access: clients can inspect files but cannot modify them or run commands.";
    case "workspace":
      return "Workspace access: clients can inspect and modify files inside this root; commands are disabled.";
    case "system":
      return "System access: clients can modify files; every new command requires local approval before it can run with this account's full environment, permissions, credentials, and network access.";
  }
}

export function statusMessage(status: RemoteWorkerStatus, connectedBefore: boolean): string {
  if (status.state === "connecting") return "Connecting to Glossa...";
  if (status.state === "connected") {
    return status.reconnected ? "Reconnected to Glossa." : "Connected to Glossa. ChatGPT can now use this workspace.";
  }
  if (status.state === "retrying") {
    const prefix = connectedBefore ? "Connection lost" : "Could not connect";
    return `${prefix}: ${status.error.message} ${retryMessage(status.retryInMs)}`;
  }
  return "Disconnected from Glossa.";
}

async function connectRemoteWorker(
  endpoints: RelayEndpoints,
  device: StoredDeviceCredential,
  worker: LocalWorker,
  options: ManagedSessionOptions,
  signal: AbortSignal,
  onConnected: () => void,
): Promise<void> {
  let connectionState: RemoteWorkerStatus["state"] | undefined;
  let connectedBefore = false;
  let connectHintTask: Promise<void> | undefined;
  const remoteWorker = new RemoteWorker({
    origin: endpoints.workerOrigin,
    deviceToken: device.token,
    ...(options.workerVersion ? { workerVersion: options.workerVersion } : {}),
    accessProfile: options.accessProfile ?? DEFAULT_WORKER_ACCESS_PROFILE,
    ...(options.workspaceLabel
      ? { workspaceLabel: options.workspaceLabel }
      : {}),
    worker: visibleWorker(worker, options),
    signal,
    onStatus(status) {
      if (status.state === "connected") {
        connectedBefore = true;
        onConnected();
      }
      if (status.state !== "retrying" || connectionState !== "retrying") {
        report(options, { type: "status", status }, statusMessage(status, connectedBefore));
      } else {
        options.onEvent?.({ type: "status", status });
      }
      if (
        status.state === "connected" &&
        !status.reconnected &&
        shouldShowConnectHint(endpoints.relayOrigin) &&
        !connectHintTask
      ) {
        connectHintTask = announceConnectHint(
          connectHintStore(),
          (message) => {
            report(
              options,
              { type: "notice", message, persistAfterExit: true },
              message,
            );
          },
        ).then(() => undefined).catch(() => undefined);
      }
      connectionState = status.state;
    },
  });
  try {
    await remoteWorker.run();
  } finally {
    await connectHintTask;
  }
}

export async function runManagedSession(
  root: string,
  endpoints: RelayEndpoints,
  options: ManagedSessionOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  const handleProcessSignals = options.handleProcessSignals ?? true;
  let worker: LocalWorker | undefined;

  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", stop, { once: true });
  if (handleProcessSignals) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  try {
    const accessProfile =
      options.accessProfile ?? DEFAULT_WORKER_ACCESS_PROFILE;
    const sessionOptions: ManagedSessionOptions = { ...options, accessProfile };
    const device = options.device ?? await deviceForSession(
      endpoints,
      {},
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (accessProfile === "system" && !options.authorizeCommand) {
      throw new Error(
        "System access requires a local command-approval handler.",
      );
    }
    worker = await LocalWorker.create(
      root,
      accessProfile,
      options.authorizeCommand,
    );
    controller.signal.throwIfAborted();

    report(
      options,
      {
        type: "session",
        root: worker.policy.root,
        deviceName: device.deviceName,
        accessProfile,
      },
      `Glossa worker root: ${worker.policy.root}`,
    );
    if (!options.quiet) {
      console.error(`Glossa device: ${device.deviceName}`);
      console.error(accessProfileSummary(accessProfile));
      console.error("Press Ctrl+C to disconnect.");
    }

    await connectRemoteWorker(
      endpoints,
      device,
      worker,
      sessionOptions,
      controller.signal,
      () => undefined,
    );
  } catch (error) {
    if (error instanceof DeviceRejectedError) {
      await deleteDeviceCredential();
      throw new Error("The relay rejected this paired computer. Run Glossa again to pair it with your account.");
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    if (handleProcessSignals) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    await worker?.shutdown();
  }
}
