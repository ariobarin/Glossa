import {
  containsRestrictedAuthenticationData,
  DEFAULT_WORKER_ACCESS_PROFILE,
  type WorkerAccessProfile,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import { announceConnectHint, connectHintStore, shouldShowConnectHint } from "../first-run.js";
import { observeMcpContractVersion } from "../update-state.js";
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
import { LocalWorker } from "./local-worker.js";
import {
  DeviceRejectedError,
  RemoteWorker,
  type WorkerHandler,
  type RemoteWorkerStatus,
} from "./remote-worker.js";

export interface ManagedActivityOutput {
  kind: "success" | "error" | "running";
  preview?: string;
  sequence?: number;
  truncated?: boolean;
}

export type ManagedSessionEvent =
  | {
      type: "session";
      root: string;
      deviceName: string;
      accessProfile: WorkerAccessProfile;
    }
  | { type: "status"; status: RemoteWorkerStatus }
  | { type: "activity"; phase: "started"; job: WorkerJob }
  | {
      type: "activity";
      phase: "returned";
      job: WorkerJob;
      ok: boolean;
      output?: ManagedActivityOutput;
    }
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

const MAX_ACTIVITY_OUTPUT_CHARS = 512;
const OUTPUT_TRUNCATION_MARKER = "… output truncated …";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeActivityOutputControls(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\n") {
      escaped += character;
    } else if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function boundedActivityPreview(
  text: string,
  sourceTruncated = false,
): { preview?: string; truncated?: boolean } {
  const normalized = text.replaceAll("\r\n", "\n").trimEnd();
  if (containsRestrictedAuthenticationData(normalized)) {
    return { preview: "[restricted output blocked]" };
  }
  const safe = escapeActivityOutputControls(normalized);
  if (!safe) return sourceTruncated
    ? { preview: OUTPUT_TRUNCATION_MARKER, truncated: true }
    : {};
  const characters = Array.from(safe);
  if (
    characters.length <= MAX_ACTIVITY_OUTPUT_CHARS &&
    (!sourceTruncated || characters.length + OUTPUT_TRUNCATION_MARKER.length + 1 <= MAX_ACTIVITY_OUTPUT_CHARS)
  ) {
    return sourceTruncated
      ? { preview: `${safe}\n${OUTPUT_TRUNCATION_MARKER}`, truncated: true }
      : { preview: safe };
  }
  const marker = `\n${OUTPUT_TRUNCATION_MARKER}\n`;
  const remaining = Math.max(2, MAX_ACTIVITY_OUTPUT_CHARS - marker.length);
  const headLength = Math.floor(remaining * 0.7);
  const tailLength = remaining - headLength;
  return {
    preview: `${characters.slice(0, headLength).join("")}${marker}${characters.slice(-tailLength).join("")}`,
    truncated: true,
  };
}

function formatOutputBytes(bytes: unknown): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

function activitySuccess(preview: string, sourceTruncated = false): ManagedActivityOutput {
  return {
    kind: "success",
    ...boundedActivityPreview(preview, sourceTruncated),
  };
}

function commandElapsedFallback(elapsedMs: unknown): string | undefined {
  if (
    typeof elapsedMs !== "number" ||
    !Number.isInteger(elapsedMs) ||
    elapsedMs < 0
  ) return undefined;
  return `Command is still running after ${Math.floor(elapsedMs / 1_000)}s with no captured output.`;
}

function commandActivityOutput(value: unknown): ManagedActivityOutput | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  const status = value.status;
  let kind: ManagedActivityOutput["kind"];
  let fallback: string;
  if (status === "running") {
    kind = "running";
    fallback = commandElapsedFallback(value.elapsedMs) ?? "Command started and is still running.";
  } else if (status === "succeeded") {
    kind = "success";
    fallback = "Command completed successfully.";
  } else if (status === "canceled") {
    kind = "success";
    fallback = "Command canceled.";
  } else if (status === "timed_out") {
    kind = "error";
    fallback = "Command timed out.";
  } else if (status === "failed") {
    kind = "error";
    fallback = typeof value.exitCode === "number"
      ? `Command failed with exit code ${value.exitCode}.`
      : "Command failed.";
  } else {
    return undefined;
  }

  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  const preferError = kind === "error";
  const previewText = preferError
    ? stderr || stdout
    : stdout || stderr;
  const sourceTruncated = previewText === stderr
    ? value.stderrTruncated === true
    : value.stdoutTruncated === true;
  return {
    kind,
    ...boundedActivityPreview(previewText || fallback, sourceTruncated),
  };
}

function listFilesActivityOutput(value: unknown): ManagedActivityOutput | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  const lines = value.entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") return [];
    const suffix = entry.type === "directory"
      ? "/"
      : formatOutputBytes(entry.bytes)
        ? ` · ${formatOutputBytes(entry.bytes)}`
        : "";
    return [`${entry.path}${suffix}`];
  });
  return activitySuccess(
    lines.length > 0 ? lines.join("\n") : "No entries.",
    value.truncated === true,
  );
}

function searchTextActivityOutput(value: unknown): ManagedActivityOutput | undefined {
  if (!isRecord(value) || !Array.isArray(value.matches)) return undefined;
  const lines = value.matches.flatMap((match) => {
    if (
      !isRecord(match) ||
      typeof match.path !== "string" ||
      typeof match.line !== "number" ||
      typeof match.column !== "number" ||
      typeof match.text !== "string"
    ) return [];
    return [`${match.path}:${match.line}:${match.column}  ${match.text}${match.lineTruncated === true ? " …" : ""}`];
  });
  return activitySuccess(
    lines.length > 0 ? lines.join("\n") : "No matches.",
    value.truncated === true,
  );
}

function activityOutput(job: WorkerJob, result: WorkerResult): ManagedActivityOutput {
  if (!result.ok) {
    return {
      kind: "error",
      ...boundedActivityPreview(result.error?.message ?? "The worker operation failed."),
    };
  }

  const value = result.value;
  switch (job.type) {
    case "read_file":
      if (isRecord(value) && typeof value.content === "string") {
        return activitySuccess(value.content || "(empty file)");
      }
      break;
    case "view_image":
      if (isRecord(value)) {
        const size = formatOutputBytes(value.bytes);
        const mimeType = typeof value.mimeType === "string" ? value.mimeType : "image";
        return activitySuccess(`Loaded ${mimeType}${size ? ` · ${size}` : ""}.`);
      }
      break;
    case "list_files": {
      const output = listFilesActivityOutput(value);
      if (output) return output;
      break;
    }
    case "search_text": {
      const output = searchTextActivityOutput(value);
      if (output) return output;
      break;
    }
    case "read_file_range":
      if (isRecord(value) && typeof value.content === "string") {
        return activitySuccess(value.content || "(empty range)", value.nextLine !== undefined);
      }
      break;
    case "write_file":
      if (isRecord(value)) {
        const size = formatOutputBytes(value.bytes);
        return activitySuccess(size ? `Wrote ${size}.` : "File written.");
      }
      break;
    case "edit_file":
      if (isRecord(value) && typeof value.diff === "string") {
        return activitySuccess(value.diff || "Edit applied.", value.diffTruncated === true);
      }
      break;
    case "make_directory":
      if (isRecord(value) && typeof value.created === "boolean") {
        return activitySuccess(value.created ? "Directory created." : "Directory already existed.");
      }
      break;
    case "delete_path":
      if (isRecord(value) && typeof value.deletedType === "string") {
        return activitySuccess(`Deleted ${value.deletedType}.`);
      }
      break;
    case "move_path":
      if (isRecord(value) && typeof value.movedType === "string") {
        return activitySuccess(`Moved ${value.movedType}.`);
      }
      break;
    case "run_command":
    case "cancel_command": {
      const output = commandActivityOutput(value);
      if (output) return output;
      break;
    }
    case "get_command": {
      const output = commandActivityOutput(value);
      if (output) {
        return isRecord(value) &&
            typeof value.sequence === "number" &&
            Number.isInteger(value.sequence) &&
            value.sequence >= 0
          ? { ...output, sequence: value.sequence }
          : output;
      }
      break;
    }
    case "read_command_output":
      if (isRecord(value)) {
        const content = typeof value.content === "string" ? value.content : "";
        const sourceTruncated = value.nextOffset !== undefined || value.retentionTruncated === true;
        return activitySuccess(content || "No output in this range.", sourceTruncated);
      }
      break;
  }
  return activitySuccess("Completed successfully.");
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
            output: activityOutput(job, result),
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
            output: {
              kind: "error",
              ...boundedActivityPreview(
                error instanceof Error ? error.message : "The worker operation failed.",
              ),
            },
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
      return "System access: clients can modify files and run commands with this account's full environment, permissions, credentials, and network access.";
  }
}

export function statusMessage(status: RemoteWorkerStatus, connectedBefore: boolean): string {
  if (status.state === "connecting") return "Connecting to Glossa...";
  if (status.state === "connected") {
    return status.reconnected ? "Reconnected to Glossa." : "Connected to Glossa. ChatGPT can now use this workspace.";
  }
  if (status.state === "retrying") {
    const prefix = connectedBefore ? "Connection lost" : "Could not connect";
    const message = status.error.message.trim();
    const reason = /[.!?]$/.test(message) ? message : `${message}.`;
    return `${prefix}: ${reason} ${retryMessage(status.retryInMs)}`;
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
  let mcpContractTask = Promise.resolve();
  let observedMcpContractVersion: string | undefined;
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
        options.workerVersion &&
        status.mcpContractVersion &&
        status.mcpContractVersion !== observedMcpContractVersion
      ) {
        observedMcpContractVersion = status.mcpContractVersion;
        const mcpContractVersion = status.mcpContractVersion;
        mcpContractTask = mcpContractTask.then(async () => {
          if (!await observeMcpContractVersion(options.workerVersion!, mcpContractVersion)) return;
          const message = "Glossa's ChatGPT tools changed. Refresh or rescan the Glossa app in ChatGPT before using new tools.";
          report(options, { type: "notice", message }, message);
        }).catch(() => undefined);
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
    await mcpContractTask;
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
