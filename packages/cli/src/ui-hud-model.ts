import {
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  type WorkerAccessProfile,
} from "@glossa/protocol";
import { activityCallFromEventJob } from "./activity-call.js";
import {
  statusMessage,
  type ManagedActivityOutput,
  type ManagedSessionEvent,
} from "./worker/managed-session.js";
import {
  activityCallByteLength,
  escapeActivityText as escapeInline,
  formatByteCount,
  formatActivityCall,
  truncateMiddle,
  type HudActivityCall,
  type HudActivityMode,
} from "./ui-hud-activity.js";

export interface HudActivitySummary {
  target: string;
  targetSegments?: [leading: string, separator: string, trailing: string];
  details: string[];
  truncation: "end" | "middle";
}

export interface HudActivity {
  tool: HudActivityCall["type"];
  summary: HudActivitySummary;
  compactSummary?: string;
  call?: HudActivityCall;
  callBytes?: number;
  callUnavailable?: "expired" | "oversized";
  output?: ManagedActivityOutput;
  requestId: string;
  state: "working" | "returned" | "failed";
  startedAt?: number;
  updatedAt?: number;
}

export interface HudDevice {
  id: string;
  name: string;
  platform: string;
  lastSeen: string;
  status: string;
  current?: boolean;
}

export interface HudStatus {
  relay: string;
  activeWorkers: number | null;
  devices: HudDevice[];
}

type HudView = "activity" | "activity-detail" | "workspace" | "devices";
type HudPrompt =
  | { type: "revoke-confirm"; deviceIndex: number }
  | { type: "access-confirm"; accessProfile: WorkerAccessProfile };

export interface HudState {
  workspace: string;
  accessProfile?: WorkerAccessProfile;
  deviceName?: string;
  connection:
    | "starting"
    | "connecting"
    | "connected"
    | "retrying"
    | "disconnected"
    | "error";
  connectedBefore: boolean;
  message: string | undefined;
  activities: HudActivity[];
  activityMode: HudActivityMode;
  activitySelection: string | undefined;
  activityBrowseAnchor: string | undefined;
  activityDetailScroll: number;
  view: HudView;
  status: HudStatus | undefined;
  deviceSelection: number;
  pendingAccessProfile: WorkerAccessProfile | undefined;
  statusLoading: boolean;
  prompt: HudPrompt | undefined;
  busy: boolean;
  busyMessage: string | undefined;
  notice: string | undefined;
  noticeTone: "info" | "success" | "error" | undefined;
}

export interface HudUiActions {
  workspace: string;
  workspaceLabel?: string;
  initialNotice?: string;
  run(
    signal: AbortSignal,
    onEvent: (event: ManagedSessionEvent) => void,
  ): Promise<void>;
  loadStatus(signal: AbortSignal): Promise<HudStatus>;
  revokeDevice(deviceId: string, signal: AbortSignal): Promise<void>;
  changeAccessProfile(accessProfile: WorkerAccessProfile): void;
}

export function retainPostExitNotice(
  current: string | undefined,
  event: ManagedSessionEvent,
): string | undefined {
  return event.type === "notice" && event.persistAfterExit
    ? event.message
    : current;
}

export function initialHudState(workspace: string): HudState {
  return {
    workspace,
    connection: "starting",
    connectedBefore: false,
    message: undefined,
    activities: [],
    activityMode: "compact",
    activitySelection: undefined,
    activityBrowseAnchor: undefined,
    activityDetailScroll: 0,
    view: "workspace",
    status: undefined,
    deviceSelection: 0,
    pendingAccessProfile: undefined,
    statusLoading: false,
    prompt: undefined,
    busy: false,
    busyMessage: undefined,
    notice: undefined,
    noticeTone: undefined,
  };
}

const MAX_STORED_ACTIVITIES = 256;
const MAX_STORED_ACTIVITY_TARGET_CHARS = 512;
const MAX_RETAINED_ACTIVITY_CALL_BYTES = 1024 * 1024;

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function quoteInline(value: string): string {
  return `"${escapeInline(value, true)}"`;
}

function boundInlineInput(value: string): string {
  return truncateMiddle(value, MAX_STORED_ACTIVITY_TARGET_CHARS);
}

function quoteActivityInput(value: string): string {
  return quoteInline(boundInlineInput(value));
}

function workspacePath(path: string | undefined): string {
  return path || ".";
}

function pathSummary(
  path: string,
  details: string[] = [],
): HudActivitySummary {
  return {
    target: `path ${quoteActivityInput(path)}`,
    details,
    truncation: "middle",
  };
}

function assertNever(_value: never): never {
  throw new Error("Unsupported activity type.");
}

function summarizeCall(job: HudActivityCall): HudActivitySummary {
  switch (job.type) {
    case "read_file":
    case "view_image":
      return pathSummary(job.path);
    case "list_files":
      return pathSummary(workspacePath(job.path), [
        ...(job.recursive ? ["recursive"] : []),
        ...(job.limit ? [`limit ${job.limit}`] : []),
        ...(job.cursor ? [`after ${quoteActivityInput(job.cursor)}`] : []),
        ...(job.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS
          ? []
          : [`timeout ${job.timeoutMs} ms`]),
      ]);
    case "search_text": {
      const leading = `query ${quoteActivityInput(job.query)}`;
      const trailing = `path ${quoteActivityInput(workspacePath(job.path))}`;
      return {
        target: `${leading} in ${trailing}`,
        targetSegments: [leading, " in ", trailing],
        details: [
          ...(job.extensions?.length
            ? [
                `extensions ${
                  job.extensions.map((extension) => escapeInline(extension)).join(", ")
                }`,
              ]
            : []),
          ...(job.caseSensitive ? ["case-sensitive"] : []),
          ...(job.maxResults ? [`limit ${job.maxResults}`] : []),
          ...(job.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS
            ? []
            : [`timeout ${job.timeoutMs} ms`]),
        ],
        truncation: "middle",
      };
    }
    case "read_file_range": {
      let range: string | undefined;
      if (job.startLine && job.lineCount) {
        range = `lines ${job.startLine}–${job.startLine + job.lineCount - 1}`;
      } else if (job.startLine) range = `from line ${job.startLine}`;
      else if (job.lineCount) range = `first ${job.lineCount} lines`;
      return pathSummary(job.path, [
        ...(range ? [range] : []),
        ...(job.timeoutMs === MAX_STRUCTURED_READ_TIMEOUT_MS
          ? []
          : [`timeout ${job.timeoutMs} ms`]),
      ]);
    }
    case "write_file":
      return pathSummary(job.path, [
        formatByteCount(job.contentBytes),
        ...(job.expectedSha256 ? ["guarded"] : []),
      ]);
    case "edit_file":
      return pathSummary(job.path, [
        `${job.editCount} ${job.editCount === 1 ? "edit" : "edits"}`,
        ...(job.expectedSha256 ? ["guarded"] : []),
      ]);
    case "make_directory":
      return pathSummary(job.path, job.recursive ? ["recursive"] : []);
    case "delete_path":
      return pathSummary(job.path, job.recursive ? ["recursive"] : []);
    case "move_path":
      return {
        target: `${quoteActivityInput(job.source)} → ${quoteActivityInput(job.destination)}`,
        details: [],
        truncation: "middle",
      };
    case "run_command":
      return {
        target: job.argv
          ? `argv [${job.argv.map(quoteActivityInput).join(", ")}]`
          : `shell ${quoteActivityInput(job.shellCommand ?? "")}`,
        details: [
          ...(job.stdinBytes === undefined
            ? []
            : [`stdin ${formatByteCount(job.stdinBytes)}`]),
          ...(job.timeoutMs === DEFAULT_COMMAND_TIMEOUT_MS
            ? []
            : [`timeout ${job.timeoutMs} ms`]),
          ...(job.waitMs === undefined ||
              job.waitMs === DEFAULT_COMMAND_FAST_WAIT_MS
            ? []
            : [`wait ${job.waitMs} ms`]),
        ],
        truncation: "middle",
      };
    case "get_command":
      return {
        target: `command ${job.commandId}`,
        details: [
          ...(job.waitMs ? [`wait ${job.waitMs} ms`] : []),
          ...(job.afterSequence === undefined
            ? []
            : [`after sequence ${job.afterSequence}`]),
        ],
        truncation: "middle",
      };
    case "read_command_output":
      return {
        target: `command ${job.commandId} ${job.stream}`,
        details: [
          ...(job.offset === undefined ? [] : [`offset ${job.offset}`]),
          ...(job.maxBytes === undefined ? [] : [`max ${job.maxBytes} bytes`]),
        ],
        truncation: "middle",
      };
    case "cancel_command":
      return {
        target: `command ${job.commandId}`,
        details: [],
        truncation: "middle",
      };
    default:
      return assertNever(job);
  }
}

function fitTargetSegments(
  segments: [leading: string, separator: string, trailing: string],
  width: number,
): [leading: string, separator: string, trailing: string] | undefined {
  const [leading, separator, trailing] = segments;
  if (leading.length + separator.length + trailing.length <= width) {
    return segments;
  }
  const available = width - separator.length;
  if (available < 2) return undefined;
  const balancedLeadingWidth = Math.floor(available / 2);
  const balancedTrailingWidth = available - balancedLeadingWidth;
  const leadingWidth = leading.length <= balancedLeadingWidth
    ? leading.length
    : trailing.length <= balancedTrailingWidth
      ? available - trailing.length
      : balancedLeadingWidth;
  return [
    truncateMiddle(leading, leadingWidth),
    separator,
    truncateMiddle(trailing, available - leadingWidth),
  ];
}

function boundActivitySummary(summary: HudActivitySummary): HudActivitySummary {
  const targetSegments = summary.targetSegments
    ? fitTargetSegments(
        summary.targetSegments,
        MAX_STORED_ACTIVITY_TARGET_CHARS,
      )
    : undefined;
  return {
    ...summary,
    ...(targetSegments ? {
      targetSegments: targetSegments.map(ownText) as typeof targetSegments,
    } : {}),
    target: ownText(targetSegments
      ? targetSegments.join("")
      : summary.truncation === "middle"
        ? truncateMiddle(summary.target, MAX_STORED_ACTIVITY_TARGET_CHARS)
        : truncate(summary.target, MAX_STORED_ACTIVITY_TARGET_CHARS)),
  };
}

function ownText(text: string): string {
  // Own the bounded text; a V8 substring can otherwise retain the full call.
  return Buffer.from(text, "utf16le").toString("utf16le");
}

export function applyHudEvent(
  state: HudState,
  event: ManagedSessionEvent,
): HudState {
  if (event.type === "session") {
    const accessHandoff = state.pendingAccessProfile === event.accessProfile;
    return {
      ...state,
      workspace: event.root,
      deviceName: event.deviceName,
      ...(accessHandoff && state.accessProfile
        ? { accessProfile: state.accessProfile }
        : { accessProfile: event.accessProfile }),
      pendingAccessProfile: accessHandoff ? state.pendingAccessProfile : undefined,
    };
  }
  if (event.type === "status") {
    if (state.pendingAccessProfile && state.connectedBefore) {
      if (event.status.state === "connected") {
        return {
          ...state,
          connection: "connected",
          connectedBefore: true,
          message: undefined,
          accessProfile: state.pendingAccessProfile,
          pendingAccessProfile: undefined,
        };
      }
      if (event.status.state === "retrying") {
        return {
          ...state,
          connection: "retrying",
          message: statusMessage(event.status, true),
        };
      }
      return {
        ...state,
        connection: event.status.state,
        message: event.status.state === "disconnected"
          ? statusMessage(event.status, true)
          : undefined,
      };
    }
    if (event.status.state === "retrying") {
      return {
        ...state,
        connection: "retrying",
        message: statusMessage(event.status, state.connectedBefore),
      };
    }
    return {
      ...state,
      connection: event.status.state,
      connectedBefore:
        state.connectedBefore || event.status.state === "connected",
      message: undefined,
    };
  }
  if (event.type === "notice") {
    return { ...state, notice: event.message, noticeTone: "info" };
  }

  const requestId = event.job.requestId;
  const eventCall = activityCallFromEventJob(event.job);
  const existingIndex = state.activities.findIndex((row) => row.requestId === requestId);
  const existing = state.activities[existingIndex];
  const activityTimestamp = Date.now();
  const freshCall = existing?.callUnavailable
    ? undefined
    : existing?.call ?? eventCall;
  const freshCallBytes = existing?.callBytes ?? (freshCall ? activityCallByteLength(freshCall) : undefined);
  const retainFreshCall = freshCall !== undefined && freshCallBytes !== undefined &&
    freshCallBytes <= MAX_RETAINED_ACTIVITY_CALL_BYTES;
  const formatCall = freshCall ?? eventCall;
  const eventOutput = event.phase === "returned"
    ? event.output ?? {
        kind: event.ok ? "success" as const : "error" as const,
      }
    : undefined;
  const activity: HudActivity = {
    tool: eventCall.type,
    summary: boundActivitySummary(summarizeCall(eventCall)),
    compactSummary: existing?.compactSummary ?? ownText(
      formatActivityCall(formatCall, "compact", MAX_STORED_ACTIVITY_TARGET_CHARS),
    ),
    ...(retainFreshCall ? { call: freshCall, callBytes: freshCallBytes } : {}),
    ...(!retainFreshCall && !existing?.callUnavailable
      ? { callUnavailable: "oversized" as const }
      : existing?.callUnavailable
        ? { callUnavailable: existing.callUnavailable }
        : {}),
    ...(eventOutput ? { output: eventOutput } : {}),
    requestId,
    state: event.phase === "started"
      ? "working"
      : eventOutput?.kind === "error"
        ? "failed"
        : "returned",
    ...(existing?.startedAt !== undefined
      ? { startedAt: existing.startedAt }
      : event.phase === "started" ? { startedAt: activityTimestamp } : {}),
    updatedAt: activityTimestamp,
  };
  const activities = [...state.activities];
  if (existingIndex >= 0) activities[existingIndex] = activity;
  else activities.push(activity);
  if (activities.length > MAX_STORED_ACTIVITIES) {
    // Keep admitted in-flight requests visible as completed rows roll off.
    const oldest = activities.findIndex((row) =>
      row.state !== "working" && row.requestId !== requestId);
    activities.splice(Math.max(oldest, 0), 1);
  }
  // One bounded list owns retention; no parallel indexes need synchronizing.
  let callBytes = activities.reduce((total, row) => total + (row.callBytes ?? 0), 0);
  for (let index = 0; callBytes > MAX_RETAINED_ACTIVITY_CALL_BYTES; index += 1) {
    const row = activities[index]!;
    if (row.callBytes === undefined) continue;
    const { call: _call, callBytes: bytes, ...summaryOnly } = row;
    activities[index] = { ...summaryOnly, callUnavailable: "expired" };
    callBytes -= bytes;
  }
  const activitySelection = state.activitySelection &&
      activities.some((row) => row.requestId === state.activitySelection)
    ? state.activitySelection
    : undefined;
  const selectionExpired = state.activitySelection !== undefined && activitySelection === undefined;

  return {
    ...state,
    activities,
    activitySelection,
    activityBrowseAnchor: state.activityBrowseAnchor &&
      activities.some((row) => row.requestId === state.activityBrowseAnchor)
      ? state.activityBrowseAnchor : undefined,
    ...(selectionExpired ? {
      view: state.view === "activity-detail" ? "activity" : state.view,
      activityDetailScroll: 0,
    } : {}),
  };
}
