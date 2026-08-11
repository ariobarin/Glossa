import {
  containsRestrictedAuthenticationData,
  DEFAULT_WORKER_ACCESS_PROFILE,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import {
  accessTokenSubject,
  type FetchLike,
  validCredentials,
} from "../auth-session.js";
import { loadCredentials, type StoredCredentials } from "../config-store.js";
import { announceConnectHint, connectHintStore, shouldShowConnectHint } from "../first-run.js";
import {
  deleteDeviceCredential,
  loadDeviceCredential,
  saveDeviceCredential,
  type StoredDeviceCredential,
} from "../device-store.js";
import {
  accountOwnsDevice,
  defaultDeviceName,
  enrollDevice,
  type RelayEndpoints,
} from "../relay-client.js";
import { LocalWorker } from "./local-worker.js";
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
  credentials?: StoredCredentials;
  accessProfile?: WorkerAccessProfile;
  workspaceLabel?: string;
  workerVersion?: string;
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
  credentials?: StoredCredentials;
  accessTokenSubject?: typeof accessTokenSubject;
  loadCredentials?: typeof loadCredentials;
  validCredentials?: typeof validCredentials;
  loadDeviceCredential?: typeof loadDeviceCredential;
  deleteDeviceCredential?: typeof deleteDeviceCredential;
  saveDeviceCredential?: typeof saveDeviceCredential;
  accountOwnsDevice?: typeof accountOwnsDevice;
  enrollDevice?: typeof enrollDevice;
  defaultDeviceName?: typeof defaultDeviceName;
  fetch?: FetchLike;
}

export async function deviceForSession(
  endpoints: RelayEndpoints,
  dependencies: ManagedDeviceDependencies = {},
  signal?: AbortSignal,
): Promise<StoredDeviceCredential> {
  const loadDevice = dependencies.loadDeviceCredential ?? loadDeviceCredential;
  const loadLogin = dependencies.loadCredentials ?? loadCredentials;
  const validate = dependencies.validCredentials ?? validCredentials;
  const subjectFor = dependencies.accessTokenSubject ?? accessTokenSubject;
  const removeDevice = dependencies.deleteDeviceCredential ?? deleteDeviceCredential;
  const enroll = dependencies.enrollDevice ?? enrollDevice;
  const saveDevice = dependencies.saveDeviceCredential ?? saveDeviceCredential;
  const ownsDevice = dependencies.accountOwnsDevice ?? accountOwnsDevice;
  const name = dependencies.defaultDeviceName ?? defaultDeviceName;
  const baseFetch = dependencies.fetch ?? fetch;
  const fetchRequest: FetchLike = signal
    ? async (input, init) => await baseFetch(input, { ...init, signal })
    : baseFetch;

  signal?.throwIfAborted();
  const stored = await loadDevice();
  let credentials = dependencies.credentials;
  const currentCredentials = async (): Promise<StoredCredentials> => {
    if (credentials) return credentials;
    const loaded = await loadLogin();
    if (!loaded) throw new Error("Not signed in. Run Glossa again to sign in.");
    credentials = await validate(loaded.credentials, { fetch: fetchRequest });
    return credentials;
  };

  if (stored?.relayOrigin === endpoints.relayOrigin) {
    const current = await currentCredentials();
    const accountSubject = subjectFor(current);
    if (stored.accountSubject === accountSubject) return stored;
    if (
      stored.accountSubject === undefined &&
      await ownsDevice(endpoints, current, stored.deviceId, fetchRequest)
    ) {
      const migrated = { ...stored, accountSubject };
      await saveDevice(migrated);
      return migrated;
    }
    await removeDevice();
  }

  signal?.throwIfAborted();
  const current = await currentCredentials();
  const enrolled = await enroll(
    endpoints,
    current,
    name(),
    fetchRequest,
  );
  const bound = {
    ...enrolled,
    accountSubject: subjectFor(current),
  };
  await saveDevice(bound);
  return bound;
}

export async function reenrollRejectedDevice(
  endpoints: RelayEndpoints,
  dependencies: ManagedDeviceDependencies = {},
  signal?: AbortSignal,
): Promise<StoredDeviceCredential> {
  const remove = dependencies.deleteDeviceCredential ?? deleteDeviceCredential;
  await remove();
  return await deviceForSession(endpoints, dependencies, signal);
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
      return "System access: clients can modify files and run commands with this account's full environment, permissions, credentials, and network access.";
  }
}

export function accessProfileNotice(
  status: RemoteWorkerStatus,
  requestedProfile: WorkerAccessProfile | undefined,
): string | undefined {
  if (
    status.state !== "connected" ||
    !requestedProfile ||
    status.accessProfileAccepted !== false
  ) {
    return undefined;
  }
  return "The relay needs an update before this access profile can be shown to connected clients. Local profile enforcement remains active.";
}

export function workspaceLabelNotice(
  status: RemoteWorkerStatus,
  requestedLabel: string | undefined,
): string | undefined {
  if (
    status.state !== "connected" ||
    !requestedLabel ||
    status.workspaceLabelAccepted !== false
  ) {
    return undefined;
  }
  return "The relay needs an update before workspace labels are available. This workspace is online without the requested label.";
}

const legacyRelayNotice = "The relay needs an update before this computer can expose several workspaces at once.";

export function combinedCompatibilityNotice(
  labelNotice: string | undefined,
  profileNotice: string | undefined,
  includeLegacyRelayNotice: boolean,
): string | undefined {
  const messages = [
    labelNotice,
    profileNotice,
    includeLegacyRelayNotice ? legacyRelayNotice : undefined,
  ].filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.join(" ") : undefined;
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
  let labelNoticeShown = false;
  let profileNoticeShown = false;
  let legacyNoticeShown = false;
  let connectHintTask: Promise<void> | undefined;
  const remoteWorker = new RemoteWorker({
    origin: endpoints.workerOrigin,
    deviceToken: device.token,
    ...(options.workerVersion ? { workerVersion: options.workerVersion } : {}),
    ...(options.accessProfile ? { accessProfile: options.accessProfile } : {}),
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
      const labelNotice = labelNoticeShown
        ? undefined
        : workspaceLabelNotice(status, options.workspaceLabel);
      const profileNotice = profileNoticeShown
        ? undefined
        : accessProfileNotice(status, options.accessProfile);
      const includeLegacyNotice =
        status.state === "connected" && status.legacyRelay && !legacyNoticeShown;
      const compatibilityNotice = combinedCompatibilityNotice(
        labelNotice,
        profileNotice,
        includeLegacyNotice,
      );
      if (labelNotice) labelNoticeShown = true;
      if (profileNotice) profileNoticeShown = true;
      if (includeLegacyNotice) legacyNoticeShown = true;
      if (compatibilityNotice) {
        report(
          options,
          { type: "notice", message: compatibilityNotice },
          compatibilityNotice,
        );
      }
      if (
        status.state === "connected" &&
        !status.reconnected &&
        !compatibilityNotice &&
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

export function shouldRecoverRejectedDevice(
  error: unknown,
  recoveredRejectedDevice: boolean,
  connected: boolean,
): boolean {
  return (
    error instanceof DeviceRejectedError &&
    !recoveredRejectedDevice &&
    !connected
  );
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
    let device = await deviceForSession(
      endpoints,
      options.credentials ? { credentials: options.credentials } : {},
      controller.signal,
    );
    controller.signal.throwIfAborted();
    worker = await LocalWorker.create(root, accessProfile);
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

    let recoveredRejectedDevice = false;
    while (!controller.signal.aborted) {
      let connected = false;
      try {
        await connectRemoteWorker(
          endpoints,
          device,
          worker,
          sessionOptions,
          controller.signal,
          () => {
            connected = true;
          },
        );
        break;
      } catch (error) {
        if (!shouldRecoverRejectedDevice(
          error,
          recoveredRejectedDevice,
          connected,
        )) {
          throw error;
        }
        recoveredRejectedDevice = true;
        device = await reenrollRejectedDevice(
          endpoints,
          options.credentials ? { credentials: options.credentials } : {},
          controller.signal,
        );
      }
    }
  } catch (error) {
    if (error instanceof DeviceRejectedError) {
      await deleteDeviceCredential();
      throw new Error("The relay rejected this device. Run Glossa again to reenroll it.");
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
