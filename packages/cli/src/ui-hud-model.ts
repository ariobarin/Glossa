import {
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  type WorkerAccessProfile,
  type WorkerJob,
} from "@glossa/protocol";
import {
  statusMessage,
  type ManagedSessionEvent,
} from "./worker/managed-session.js";

export interface HudActivitySummary {
  target: string;
  targetSegments?: [leading: string, separator: string, trailing: string];
  details: string[];
  truncation: "end" | "middle";
}

export interface HudActivity {
  tool: WorkerJob["type"];
  summary: HudActivitySummary;
  requestId: string;
  state: "working" | "returned" | "failed";
  updatedAt?: number;
}

export interface HudDevice {
  id: string;
  name: string;
  platform: string;
  lastSeen: string;
  status: string;
}

export interface HudStatus {
  account: string;
  relay: string;
  activeWorkers: number | null;
  devices: HudDevice[];
}

type HudView = "activity" | "workspace" | "devices" | "help";
type HudPrompt =
  | { type: "logout" }
  | { type: "revoke-confirm"; deviceIndex: number }
  | { type: "access-confirm"; accessProfile: WorkerAccessProfile };

export type HudExitAction = "quit" | "logout";

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
  activityPage: number;
  view: HudView;
  status: HudStatus | undefined;
  deviceSelection: number;
  pendingAccessProfile: WorkerAccessProfile | undefined;
  statusLoading: boolean;
  prompt: HudPrompt | undefined;
  busy: boolean;
  notice: string | undefined;
}

export interface HudUiActions {
  workspace: string;
  workspaceLabel?: string;
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
    activityPage: 0,
    view: "workspace",
    status: undefined,
    deviceSelection: 0,
    pendingAccessProfile: undefined,
    statusLoading: false,
    prompt: undefined,
    busy: false,
    notice: undefined,
  };
}

const MAX_STORED_ACTIVITIES = 999;
const MAX_STORED_ACTIVITY_TARGET_CHARS = 512;

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  const visible = width - 1;
  const leading = Math.max(1, Math.floor(visible * 0.45));
  const trailing = visible - leading;
  let start = value.slice(0, leading);
  if (/[\ud800-\udbff]$/.test(start)) start = start.slice(0, -1);
  let end = trailing > 0 ? value.slice(-trailing) : "";
  if (/^[\udc00-\udfff]/.test(end)) end = end.slice(1);
  return `${start}…${end}`;
}

const INLINE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

function escapeCodePoint(codePoint: number): string {
  const hexadecimal = codePoint.toString(16);
  return codePoint <= 0xffff
    ? `\\u${hexadecimal.padStart(4, "0")}`
    : `\\u{${hexadecimal}}`;
}

function escapeInline(value: string, quote = false): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") escaped += "\\\\";
    else if (quote && character === '"') escaped += '\\"';
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      INLINE_DEFAULT_IGNORABLE.test(character) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      escaped += escapeCodePoint(codePoint);
    } else escaped += character;
  }
  return escaped;
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

function formatByteCount(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
  }
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
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

function summarizeJob(job: WorkerJob): HudActivitySummary {
  switch (job.type) {
    case "read_file":
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
        formatByteCount(job.content),
        ...(job.expectedSha256 ? ["guarded"] : []),
      ]);
    case "edit_file":
      return pathSummary(job.path, [
        `${job.edits.length} ${job.edits.length === 1 ? "edit" : "edits"}`,
        ...(job.expectedSha256 ? ["guarded"] : []),
      ]);
    case "run_command":
      return {
        target: job.argv
          ? `argv [${job.argv.map(quoteActivityInput).join(", ")}]`
          : `shell ${quoteActivityInput(job.shellCommand ?? "")}`,
        details: [
          ...(job.stdin === undefined
            ? []
            : [`stdin ${formatByteCount(job.stdin)}`]),
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
    ...(targetSegments ? { targetSegments } : {}),
    target: targetSegments
      ? targetSegments.join("")
      : summary.truncation === "middle"
        ? truncateMiddle(summary.target, MAX_STORED_ACTIVITY_TARGET_CHARS)
        : truncate(summary.target, MAX_STORED_ACTIVITY_TARGET_CHARS),
  };
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
      accessProfile: event.accessProfile,
      pendingAccessProfile: accessHandoff ? state.pendingAccessProfile : undefined,
    };
  }
  if (event.type === "status") {
    if (state.pendingAccessProfile && state.connectedBefore) {
      if (event.status.state !== "connected") return state;
      return {
        ...state,
        connection: "connected",
        connectedBefore: true,
        message: undefined,
        pendingAccessProfile: undefined,
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
    return { ...state, notice: event.message };
  }

  const requestId = event.job.requestId;
  const existingIndex = state.activities.findIndex(
    (activity) => activity.requestId === requestId,
  );
  const activityTimestamp = Date.now();
  const activity: HudActivity = {
    tool: event.job.type,
    summary: boundActivitySummary(summarizeJob(event.job)),
    requestId,
    state: event.phase === "started"
      ? "working"
      : event.ok
        ? "returned"
        : "failed",
    updatedAt: activityTimestamp,
  };
  const activities = [...state.activities];
  if (existingIndex >= 0) activities[existingIndex] = activity;
  else activities.push(activity);
  return {
    ...state,
    activities: activities.slice(-MAX_STORED_ACTIVITIES),
  };
}
