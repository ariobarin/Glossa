import { emitKeypressEvents, type Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  DEFAULT_COMMAND_FAST_WAIT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  type WorkerAccessProfile,
  type WorkerJob,
} from "@glossa/protocol";
import {
  accessProfileSummary,
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

type HudView = "session" | "activity" | "status" | "help";
type HudPrompt =
  | { type: "logout" }
  | { type: "revoke-select"; deviceCount: number }
  | { type: "revoke-confirm"; deviceIndex: number };

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
}

function terminalTitleSequence(label: string | undefined): string {
  const safeLabel = label?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const title = safeLabel ? `Glossa | ${safeLabel}` : "Glossa";
  return `\u001b]0;${title}\u0007`;
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
    view: "session",
    status: undefined,
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
    return {
      ...state,
      workspace: event.root,
      deviceName: event.deviceName,
      accessProfile: event.accessProfile,
    };
  }
  if (event.type === "status") {
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

const ANSI_BASE = "\u001b[22;38;2;244;241;251;48;2;17;16;22m";
const RESIZE_RENDER_DELAY_MS = 16;
const ACTIVITY_REFRESH_INTERVAL_MS = 10_000;
const PALETTE = {
  ink: "38;2;244;241;251",
  muted: "38;2;170;164;181",
  purple: "38;2;128;84;255",
  purpleReadable: "38;2;173;152;255",
  coral: "38;2;255;102;95",
  orange: "38;2;255;166;87",
  line: "38;2;92;85;110",
} as const;

function style(enabled: boolean, code: string, value: string): string {
  return enabled ? `\u001b[${code}m${value}${ANSI_BASE}` : value;
}

function sectionTitle(
  label: string,
  color: boolean,
  tone: string = PALETTE.purpleReadable,
): string {
  return style(color, `${tone};1`, label.toUpperCase());
}

function connectionLabel(state: HudState): string {
  if (state.connection === "connected") return "Connected";
  if (state.connection === "connecting" || state.connection === "starting") {
    return "Connecting";
  }
  if (state.connection === "retrying") return "Reconnecting";
  if (state.connection === "error") return "Error";
  return "Disconnected";
}

function headerLabel(state: HudState): string {
  return connectionLabel(state);
}

function renderHeader(
  state: HudState,
  usable: number,
  color: boolean,
): string[] {
  const brand = "Glossa";
  const label = truncate(
    headerLabel(state),
    Math.max(1, usable - brand.length - 1),
  );
  const gap = " ".repeat(Math.max(1, usable - brand.length - label.length));
  const tone = state.connection === "error" ? PALETTE.coral : PALETTE.purpleReadable;
  return [
    `${style(color, `${PALETTE.purple};1`, brand)}${gap}${style(color, `${tone};1`, label)}`,
    style(color, PALETTE.line, "─".repeat(usable)),
  ];
}

function renderSession(
  state: HudState,
  usable: number,
  color: boolean,
): string[] {
  const lines = [
    "",
    sectionTitle("Workspace", color),
    style(color, PALETTE.ink, truncate(state.workspace, usable)),
  ];
  if (state.accessProfile) {
    lines.push(
      "",
      sectionTitle("Access", color),
      style(
        color,
        PALETTE.ink,
        truncate(accessProfileSummary(state.accessProfile), usable),
      ),
    );
  }
  if (state.deviceName) {
    lines.push(
      "",
      sectionTitle("Device", color),
      style(color, PALETTE.ink, truncate(state.deviceName, usable)),
    );
  }
  if (
    state.message &&
    (state.connection === "retrying" || state.connection === "error")
  ) {
    lines.push(
      "",
      style(color, PALETTE.coral, truncate(state.message, usable)),
    );
  }
  return lines;
}

function renderActivitySummary(
  summary: HudActivitySummary,
  usable: number,
): string {
  if (summary.target.length > usable) {
    if (summary.targetSegments) {
      const segments = fitTargetSegments(summary.targetSegments, usable);
      if (segments) return segments.join("");
    }
    return summary.truncation === "middle"
      ? truncateMiddle(summary.target, usable)
      : truncate(summary.target, usable);
  }
  const visibleDetails: string[] = [];
  for (const detail of summary.details) {
    const candidate = [summary.target, ...visibleDetails, detail].join(" · ");
    if (candidate.length > usable) continue;
    visibleDetails.push(detail);
  }
  return [summary.target, ...visibleDetails].join(" · ");
}

function relativeActivityAge(updatedAt: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - updatedAt);
  if (elapsedMs < 10_000) return "just now";
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}

const ACTIVITY_TOOL_COLUMN_WIDTH = 15;

function activityToolTone(activity: HudActivity): string {
  if (activity.state === "working") return PALETTE.ink;
  if (activity.state === "failed") return PALETTE.orange;
  return PALETTE.purpleReadable;
}

function renderActivityRow(
  activity: HudActivity,
  usable: number,
  color: boolean,
  now = Date.now(),
): string {
  const age = activity.state === "working"
    ? "now"
    : activity.updatedAt === undefined
      ? ""
      : relativeActivityAge(activity.updatedAt, now);
  const visibleAge = age && usable >= age.length + 7 ? age : "";
  const ageSpace = visibleAge ? visibleAge.length + 2 : 0;
  const leftBudget = Math.max(1, usable - ageSpace);
  const toolWidth = Math.min(ACTIVITY_TOOL_COLUMN_WIDTH, leftBudget);
  const visibleTool = truncate(activity.tool, toolWidth).padEnd(toolWidth);
  const summaryBudget = Math.max(0, leftBudget - toolWidth - 2);
  const summary = summaryBudget > 0
    ? renderActivitySummary(activity.summary, summaryBudget)
    : "";
  const leftLength = toolWidth + (summary ? 2 + summary.length : 0);
  const gap = visibleAge
    ? " ".repeat(Math.max(2, usable - leftLength - visibleAge.length))
    : "";
  return `${style(color, `${activityToolTone(activity)};1`, visibleTool)}${
    summary ? `  ${style(color, PALETTE.muted, summary)}` : ""
  }${gap}${visibleAge ? style(color, PALETTE.muted, visibleAge) : ""}`;
}

const ACTIVITY_PREAMBLE_LINES = 3;

function activityPageCapacity(bodyBudget: number): number {
  return Math.max(0, bodyBudget - ACTIVITY_PREAMBLE_LINES);
}

function activityMaxPage(activityCount: number, pageCapacity: number): number {
  if (pageCapacity <= 0 || activityCount <= pageCapacity) return 0;
  return Math.floor((activityCount - 1) / pageCapacity);
}

function renderActivity(
  state: HudState,
  usable: number,
  color: boolean,
  bodyBudget: number,
): string[] {
  const pageCapacity = activityPageCapacity(bodyBudget);
  const maxPage = activityMaxPage(state.activities.length, pageCapacity);
  const page = Math.min(state.activityPage, maxPage);
  const rangeStart = page * pageCapacity + 1;
  const rangeEnd = Math.min(rangeStart + pageCapacity - 1, state.activities.length);
  const activityHeading = maxPage > 0
    ? `Recent activity (${rangeStart}-${rangeEnd}/${state.activities.length})`
    : "Recent activity";
  const lines = ["", sectionTitle(activityHeading, color)];
  if (state.activities.length === 0) {
    lines.push("", style(color, PALETTE.muted, "No activity yet."));
    return lines;
  }
  if (pageCapacity === 0) return lines;
  lines.push("");
  const pageEnd = state.activities.length - page * pageCapacity;
  const pageStart = Math.max(0, pageEnd - pageCapacity);
  const now = Date.now();
  for (const activity of state.activities.slice(pageStart, pageEnd)) {
    lines.push(renderActivityRow(activity, usable, color, now));
  }
  return lines;
}

function metric(
  label: string,
  value: string,
  usable: number,
  color: boolean,
): string {
  const visibleValue = truncate(value, Math.max(1, usable - 1));
  const visibleLabel = truncate(
    label,
    Math.max(0, usable - visibleValue.length - 1),
  );
  const gap = visibleLabel ? " " : "";
  return `${style(color, PALETTE.ink, visibleValue)}${gap}${style(color, PALETTE.muted, visibleLabel)}`;
}

function tableCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

function renderDeviceRows(
  device: HudDevice,
  index: number,
  usable: number,
  color: boolean,
): string[] {
  const number = String(index + 1).padStart(2);
  const statusTone = device.status.includes("active")
    ? PALETTE.purpleReadable
    : PALETTE.muted;
  if (usable < 64) {
    const prefix = `${number}  `;
    const details = `${device.name} · ${device.status} · ${device.platform} · ${device.lastSeen}`;
    return [
      `${style(color, `${PALETTE.purpleReadable};1`, number)}  ${
        style(
          color,
          statusTone,
          truncate(details, Math.max(1, usable - prefix.length)),
        )
      }`,
    ];
  }

  const statusWidth = 16;
  const platformWidth = 12;
  const lastSeenWidth = Math.min(
    18,
    Math.max(10, Math.floor(usable * 0.18)),
  );
  const nameWidth = usable - 38 - lastSeenWidth;
  return [
    `${style(color, `${PALETTE.purpleReadable};1`, number)}  ${
      style(color, PALETTE.ink, tableCell(device.name, nameWidth))
    }  ${
      style(color, statusTone, tableCell(device.status, statusWidth))
    }  ${
      style(color, PALETTE.muted, tableCell(device.platform, platformWidth))
    }  ${style(color, PALETTE.muted, tableCell(device.lastSeen, lastSeenWidth))}`,
  ];
}

function deviceTableHeading(usable: number, color: boolean): string | undefined {
  if (usable < 64) return undefined;
  const statusWidth = 16;
  const platformWidth = 12;
  const lastSeenWidth = Math.min(
    18,
    Math.max(10, Math.floor(usable * 0.18)),
  );
  const nameWidth = usable - 38 - lastSeenWidth;
  return style(
    color,
    PALETTE.muted,
    `    ${tableCell("Device", nameWidth)}  ${
      tableCell("Workers", statusWidth)
    }  ${tableCell("Platform", platformWidth)}  ${
      tableCell("Last seen", lastSeenWidth)
    }`,
  );
}

function renderStatus(
  state: HudState,
  usable: number,
  color: boolean,
  visibleDeviceCount: number,
): string[] {
  const lines = ["", sectionTitle("Account", color)];
  if (state.statusLoading) {
    lines.push("", style(color, PALETTE.muted, "Loading status…"));
    return lines;
  }
  if (!state.status) {
    lines.push("", style(color, PALETTE.muted, "Status is not loaded."));
    return lines;
  }

  const workerCount = state.status.activeWorkers === null
    ? "Unavailable"
    : String(state.status.activeWorkers);
  lines.push(
    style(color, PALETTE.ink, truncate(state.status.account, usable)),
    style(color, PALETTE.muted, truncate(state.status.relay, usable)),
    "",
    sectionTitle("Overview", color),
    metric("Active workspaces", workerCount, usable, color),
    metric("Devices", String(state.status.devices.length), usable, color),
    "",
    sectionTitle("Devices", color),
  );

  if (state.status.devices.length === 0) {
    lines.push("", style(color, PALETTE.muted, "No active devices."));
    return lines;
  }

  const heading = deviceTableHeading(usable, color);
  if (heading) lines.push(heading);
  state.status.devices.slice(0, visibleDeviceCount).forEach((device, index) => {
    lines.push(...renderDeviceRows(device, index, usable, color));
  });
  const hiddenCount = state.status.devices.length - visibleDeviceCount;
  if (hiddenCount > 0) {
    lines.push(
      style(
        color,
        PALETTE.muted,
        truncate(
          `${hiddenCount} more. Use glossa devices revoke <id>.`,
          usable,
        ),
      ),
    );
  }
  return lines;
}

function helpRows(
  key: string,
  label: string,
  usable: number,
  color: boolean,
  tone: string = PALETTE.purpleReadable,
): string[] {
  const available = Math.max(1, usable - key.length - 2);
  return [
    `${style(color, `${tone};1`, key)}  ${truncate(label, available)}`,
  ];
}

function renderHelp(usable: number, color: boolean): string[] {
  return [
    "",
    sectionTitle("Navigate", color),
    ...helpRows("D", "Recent activity", usable, color),
    ...helpRows("S", "Account and devices", usable, color),
    ...helpRows("?", "Close help", usable, color),
    "",
    sectionTitle("Manage", color, PALETTE.coral),
    ...helpRows(
      "R",
      "Revoke a device from status",
      usable,
      color,
      PALETTE.coral,
    ),
    ...helpRows("L", "Sign out", usable, color, PALETTE.coral),
    "",
    sectionTitle("Session", color),
    ...helpRows("Q", "Disconnect and quit", usable, color, PALETTE.coral),
    ...helpRows(
      "Ctrl+C",
      "Disconnect and quit",
      usable,
      color,
      PALETTE.coral,
    ),
  ];
}

function promptText(
  state: HudState,
): { message: string; choices?: string } | undefined {
  if (state.busy) return { message: "Working…" };
  if (!state.prompt) return undefined;
  if (state.prompt.type === "logout") {
    return { message: "Sign out and disconnect?", choices: "Y confirm  N cancel" };
  }
  if (state.prompt.type === "revoke-select") {
    return { message: "Choose a device number to revoke.", choices: "Esc cancel" };
  }
  const device = state.status?.devices[state.prompt.deviceIndex];
  return {
    message: `Revoke ${device?.name ?? "this device"}?`,
    choices: "Y confirm  N cancel",
  };
}

interface HudHint {
  key: string;
  label: string;
  tone?: string;
}

function footerHints(state: HudState): HudHint[] {
  if (state.view === "status") {
    return [
      { key: "R", label: "Revoke", tone: PALETTE.coral },
      { key: "L", label: "Sign out", tone: PALETTE.coral },
      { key: "Esc", label: "Session" },
      { key: "Q", label: "Quit", tone: PALETTE.coral },
    ];
  }
  if (state.view === "activity") {
    return [
      { key: "↑", label: "Older" },
      { key: "↓", label: "Newer" },
      { key: "D", label: "Session" },
      { key: "S", label: "Status" },
      { key: "?", label: "Help" },
      { key: "Q", label: "Quit", tone: PALETTE.coral },
    ];
  }
  if (state.view === "help") {
    return [
      { key: "?", label: "Session" },
      { key: "Q", label: "Quit", tone: PALETTE.coral },
    ];
  }
  return [
    { key: "D", label: "Activity" },
    { key: "S", label: "Status" },
    { key: "?", label: "Help" },
    { key: "L", label: "Sign out", tone: PALETTE.coral },
    { key: "Q", label: "Quit", tone: PALETTE.coral },
  ];
}

function renderFooter(
  state: HudState,
  usable: number,
  color: boolean,
): string[] {
  const rows: HudHint[][] = [[]];
  let rowLength = 0;
  for (const hint of footerHints(state)) {
    const tokenLength = hint.key.length + hint.label.length + 1;
    if (rows.at(-1)!.length > 0 && rowLength + 3 + tokenLength > usable) {
      rows.push([]);
      rowLength = 0;
    }
    rows.at(-1)!.push(hint);
    rowLength += (rowLength > 0 ? 3 : 0) + tokenLength;
  }
  return rows.map((row) =>
    row.map((hint) =>
      `${style(color, `${hint.tone ?? PALETTE.purpleReadable};1`, hint.key)} ${style(color, PALETTE.muted, hint.label)}`
    ).join("   ")
  );
}

function renderOverlay(
  state: HudState,
  usable: number,
  color: boolean,
): string[] {
  const prompt = promptText(state);
  const message = prompt?.message ?? state.notice;
  if (!message) return [];
  const lines = [
    style(color, PALETTE.line, "─".repeat(usable)),
    style(
      color,
      prompt ? `${PALETTE.coral};1` : PALETTE.coral,
      truncate(message, usable),
    ),
  ];
  if (prompt?.choices) {
    lines.push(style(color, PALETTE.muted, truncate(prompt.choices, usable)));
  }
  return lines;
}

export function renderHud(
  state: HudState,
  width = 80,
  color = !process.env.NO_COLOR,
  height = 24,
): string {
  const margin = width >= 24 ? "  " : "";
  const usable = Math.max(8, width - margin.length * 2);
  const terminalHeight = Math.max(6, height);
  const header = renderHeader(state, usable, color);
  const overlay = renderOverlay(state, usable, color);
  const footer = [
    style(color, PALETTE.line, "─".repeat(usable)),
    ...renderFooter(state, usable, color),
  ];
  const bodyBudget = Math.max(
    0,
    terminalHeight - header.length - overlay.length - footer.length,
  );
  const visibleDeviceCount = statusDeviceCapacity(
    state,
    bodyBudget,
    usable,
  );
  const body = state.view === "activity"
    ? renderActivity(state, usable, color, bodyBudget)
    : state.view === "status"
      ? renderStatus(state, usable, color, visibleDeviceCount)
      : state.view === "help"
        ? renderHelp(usable, color)
        : renderSession(state, usable, color);
  const visibleBody = body.slice(0, bodyBudget);
  const padding = Array.from(
    {
      length: Math.max(
        0,
        terminalHeight -
          header.length -
          visibleBody.length -
          overlay.length -
          footer.length,
      ),
    },
    () => "",
  );
  const lines = [...header, ...visibleBody, ...padding, ...overlay, ...footer]
    .slice(-terminalHeight);
  return lines.map((line) => line ? `${margin}${line}` : "").join("\n");
}

function statusDeviceCapacity(
  state: HudState,
  bodyBudget: number,
  usable: number,
): number {
  if (
    state.view !== "status" ||
    !state.status ||
    state.statusLoading ||
    state.status.devices.length === 0
  ) {
    return 0;
  }
  const statusPreambleLines = usable >= 64 ? 11 : 10;
  const available = Math.max(0, bodyBudget - statusPreambleLines);
  let visible = Math.min(9, state.status.devices.length, available);
  if (
    state.status.devices.length > visible &&
    visible > 0 &&
    available - visible < 1
  ) {
    visible -= 1;
  }
  return visible;
}

function terminalBodyBudget(
  state: HudState,
  width: number,
  height: number,
): { usable: number; bodyBudget: number } {
  const marginLength = width >= 24 ? 4 : 0;
  const usable = Math.max(8, width - marginLength);
  const terminalHeight = Math.max(6, height);
  const bodyBudget = Math.max(
    0,
    terminalHeight -
      renderHeader(state, usable, false).length -
      renderOverlay(state, usable, false).length -
      1 -
      renderFooter(state, usable, false).length,
  );
  return { usable, bodyBudget };
}

function terminalStatusDeviceCapacity(
  state: HudState,
  width: number,
  height: number,
): number {
  const { usable, bodyBudget } = terminalBodyBudget(state, width, height);
  return statusDeviceCapacity(state, bodyBudget, usable);
}

function terminalActivityPageCapacity(
  state: HudState,
  width: number,
  height: number,
): number {
  const { bodyBudget } = terminalBodyBudget(state, width, height);
  return activityPageCapacity(bodyBudget);
}

export async function runSessionHud(
  actions: HudUiActions,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<HudExitAction> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Glossa requires an interactive terminal.");
  }

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  const controller = new AbortController();
  let state = initialHudState(actions.workspace);
  let exitAction: HudExitAction = "quit";
  let stopUi: (() => void) | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let activityRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastRenderedLines: string[] = [];
  let uiReady = false;
  const color = !process.env.NO_COLOR;

  const render = (): void => {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = undefined;
    }
    const lines = renderHud(
      state,
      output.columns ?? 80,
      color,
      output.rows ?? 24,
    ).split("\n");
    const changed: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (lastRenderedLines[index] === line) continue;
      changed.push(`\u001b[${index + 1};1H\u001b[2K${line}`);
    }
    lastRenderedLines = lines;
    if (changed.length > 0) {
      output.write(`${color ? ANSI_BASE : ""}${changed.join("")}`);
    }
  };

  const resize = (): void => {
    if (state.view === "activity") {
      const pageCapacity = terminalActivityPageCapacity(
        state,
        output.columns ?? 80,
        output.rows ?? 24,
      );
      const maxPage = activityMaxPage(state.activities.length, pageCapacity);
      if (state.activityPage > maxPage) {
        state = { ...state, activityPage: maxPage };
      }
    }
    if (
      state.prompt?.type === "revoke-select" ||
      state.prompt?.type === "revoke-confirm"
    ) {
      const deviceCount = terminalStatusDeviceCapacity(
        state,
        output.columns ?? 80,
        output.rows ?? 24,
      );
      const selectedDeviceIsHidden = state.prompt.type === "revoke-confirm" &&
        state.prompt.deviceIndex >= deviceCount;
      if (deviceCount === 0 || selectedDeviceIsHidden) {
        state = {
          ...state,
          prompt: undefined,
          notice: "Increase the terminal height to choose a device.",
        };
      } else if (state.prompt.type === "revoke-select") {
        state = {
          ...state,
          prompt: { type: "revoke-select", deviceCount },
        };
      }
    }
    if (!resizeTimer) {
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        lastRenderedLines = [];
        if (!controller.signal.aborted) render();
      }, RESIZE_RENDER_DELAY_MS);
    }
  };

  const loadStatus = async (): Promise<void> => {
    if (state.statusLoading) return;
    if (state.connection !== "connected" && state.connection !== "retrying") {
      state = { ...state, notice: "Status is available after Glossa connects." };
      render();
      return;
    }
    state = {
      ...state,
      view: "status",
      statusLoading: true,
      prompt: undefined,
      notice: undefined,
    };
    render();
    try {
      const status = await actions.loadStatus(controller.signal);
      if (controller.signal.aborted) return;
      state = { ...state, status, statusLoading: false };
    } catch (error) {
      if (controller.signal.aborted) return;
      state = {
        ...state,
        statusLoading: false,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    render();
  };

  const session = actions.run(controller.signal, (event) => {
    state = applyHudEvent(state, event);
    if (uiReady) render();
  }).then(() => {
    if (!controller.signal.aborted) {
      state = { ...state, connection: "disconnected" };
    }
    if (uiReady) render();
  }).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    state = {
      ...state,
      connection: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    if (uiReady) render();
    throw error;
  });

  input.setRawMode(true);
  input.resume();
  output.write(`${terminalTitleSequence(actions.workspaceLabel)}\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H`);
  lastRenderedLines = [];
  uiReady = true;
  output.on("resize", resize);
  activityRefreshTimer = setInterval(() => {
    if (
      !controller.signal.aborted &&
      state.view === "activity" &&
      state.activities.length > 0
    ) {
      render();
    }
  }, ACTIVITY_REFRESH_INTERVAL_MS);
  activityRefreshTimer.unref();
  render();

  const stop = (action: HudExitAction = "quit"): void => {
    exitAction = action;
    controller.abort();
    stopUi?.();
  };
  const stopFromSignal = (): void => stop();
  process.once("SIGINT", stopFromSignal);
  process.once("SIGTERM", stopFromSignal);

  try {
    await new Promise<void>((resolve) => {
      const onKeypress = (value: string, key: Key): void => {
        if ((key.ctrl && key.name === "c") || key.name === "q") return stop();
        if (state.busy) return;

        if (state.prompt) {
          if (key.name === "escape" || key.name === "n") {
            state = { ...state, prompt: undefined, notice: undefined };
            render();
            return;
          }
          if (state.prompt.type === "revoke-select") {
            const deviceIndex = Number(value) - 1;
            if (
              Number.isInteger(deviceIndex) &&
              deviceIndex >= 0 &&
              deviceIndex < state.prompt.deviceCount
            ) {
              state = {
                ...state,
                prompt: { type: "revoke-confirm", deviceIndex },
              };
              render();
            }
            return;
          }
          if (key.name !== "y") return;
          if (state.prompt.type === "logout") return stop("logout");
          const device = state.status?.devices[state.prompt.deviceIndex];
          if (!device) return;
          state = {
            ...state,
            busy: true,
            prompt: undefined,
            notice: undefined,
          };
          render();
          void actions.revokeDevice(device.id, controller.signal).then(
            async () => {
              if (controller.signal.aborted) return;
              state = {
                ...state,
                busy: false,
              };
              await loadStatus();
              if (controller.signal.aborted) return;
              state = {
                ...state,
                notice: `Revoked ${device.name}.`,
              };
              render();
            },
          ).catch((error: unknown) => {
            if (controller.signal.aborted) return;
            state = {
              ...state,
              busy: false,
              notice: error instanceof Error ? error.message : String(error),
            };
            render();
          });
          return;
        }

        if (
          state.view === "activity" &&
          (key.name === "up" || key.name === "down")
        ) {
          const pageCapacity = terminalActivityPageCapacity(
            state,
            output.columns ?? 80,
            output.rows ?? 24,
          );
          const maxPage = activityMaxPage(state.activities.length, pageCapacity);
          const nextPage = key.name === "up"
            ? Math.min(maxPage, state.activityPage + 1)
            : Math.max(0, state.activityPage - 1);
          if (nextPage !== state.activityPage) {
            state = { ...state, activityPage: nextPage };
            render();
          }
          return;
        }

        if (key.name === "escape") {
          state = { ...state, view: "session", notice: undefined };
          render();
        } else if (key.name === "d") {
          const enteringActivity = state.view !== "activity";
          state = {
            ...state,
            view: enteringActivity ? "activity" : "session",
            activityPage: enteringActivity ? 0 : state.activityPage,
            notice: undefined,
          };
          render();
        } else if (key.name === "s") {
          void loadStatus();
        } else if (key.name === "r" && state.view === "status") {
          if ((state.status?.devices.length ?? 0) === 0) {
            state = { ...state, notice: "There are no devices to revoke." };
          } else {
            const promptState: HudState = {
              ...state,
              prompt: { type: "revoke-select", deviceCount: 0 },
              notice: undefined,
            };
            const deviceCount = terminalStatusDeviceCapacity(
              promptState,
              output.columns ?? 80,
              output.rows ?? 24,
            );
            state = deviceCount === 0
              ? {
                  ...state,
                  notice: "Increase the terminal height to choose a device.",
                }
              : {
                  ...promptState,
                  prompt: { type: "revoke-select", deviceCount },
                };
          }
          render();
        } else if (key.name === "l") {
          state = {
            ...state,
            prompt: { type: "logout" },
            notice: undefined,
          };
          render();
        } else if (value === "?" || key.sequence === "?") {
          state = {
            ...state,
            view: state.view === "help" ? "session" : "help",
            notice: undefined,
          };
          render();
        }
      };
      input.on("keypress", onKeypress);
      void session.catch(() => stopUi?.());
      stopUi = () => {
        input.removeListener("keypress", onKeypress);
        resolve();
      };
    });
    await session;
    return exitAction;
  } finally {
    if (resizeTimer) clearTimeout(resizeTimer);
    if (activityRefreshTimer) clearInterval(activityRefreshTimer);
    output.removeListener("resize", resize);
    process.removeListener("SIGINT", stopFromSignal);
    process.removeListener("SIGTERM", stopFromSignal);
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\u001b[0m\u001b[?25h\u001b[?1049l");
  }
}
