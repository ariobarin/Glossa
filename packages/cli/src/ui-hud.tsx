import type { ReadStream, WriteStream } from "node:tty";
import type { WorkerAccessProfile } from "@glossa/protocol";
import { stripVTControlCharacters } from "node:util";
import React, {
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Box,
  Text as InkText,
  render,
  renderToString,
  useInput,
  useWindowSize,
} from "ink";

import {
  applyHudEvent,
  initialHudState,
  type HudActivity,
  type HudDevice,
  type HudState,
  type HudUiActions,
} from "./ui-hud-model.js";
import {
  activityCallDetailFields,
  activityToolTitle,
  formatActivityCall,
  type HudActivityMode,
} from "./ui-hud-activity.js";

const COLORS = {
  ink: "#f4f1fb",
  muted: "#aaa4b5",
  purple: "#8054ff",
  purpleReadable: "#ad98ff",
  success: "#65d6a6",
  coral: "#ff665f",
  line: "#5c556e",
} as const;

type InkTextProps = React.ComponentProps<typeof InkText>;
type HudTextProps = Omit<InkTextProps, "color"> & {
  color?: InkTextProps["color"] | undefined;
};

function Text({ color, ...props }: HudTextProps): React.ReactNode {
  return color === undefined
    ? <InkText {...props} />
    : <InkText {...props} color={color} />;
}

const ACTIVITY_IDLE_REFRESH_INTERVAL_MS = 10_000;
const ACTIVITY_LIVE_REFRESH_INTERVAL_MS = 1_000;
const ACTIVITY_SELECTOR_COLUMN_WIDTH = 2;
const ACTIVITY_STATUS_COLUMN_WIDTH = 2;
const ACTIVITY_TOOL_COLUMN_WIDTH = 15;
const ACTIVITY_AGE_COLUMN_WIDTH = 10;
const ACTIVITY_PREAMBLE_LINES = 1;

interface HudHint {
  key: string;
  label: string;
  labelWidth?: number;
  tone?: string;
}

interface HudFooterRow {
  left: HudHint[];
  right: HudHint[];
}

interface HudScreenMetrics {
  usable: number;
  bodyBudget: number;
  footerRows: HudFooterRow[];
  overlayRows: number;
}

class HudStore {
  #state: HudState;
  #listeners = new Set<() => void>();

  constructor(workspace: string, initialNotice?: string) {
    this.#state = {
      ...initialHudState(workspace),
      ...(initialNotice ? { notice: initialNotice } : {}),
    };
  }

  getSnapshot = (): HudState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  update(update: (state: HudState) => HudState): void {
    const next = update(this.#state);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  event(event: Parameters<typeof applyHudEvent>[1]): void {
    this.update((state) => applyHudEvent(state, event));
  }
}

function terminalTitleSequence(label: string | undefined): string {
  const safeLabel = label?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return `\u001b]0;${safeLabel ? `Glossa | ${safeLabel}` : "Glossa"}\u0007`;
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

function liveDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function activityAge(activity: HudActivity, now: number): string {
  if (activity.state === "working") {
    const startedAt = activity.startedAt ?? activity.updatedAt;
    return startedAt === undefined ? "now" : liveDuration(now - startedAt);
  }
  if (activity.updatedAt === undefined) return "";
  const elapsedMs = Math.max(0, now - activity.updatedAt);
  if (elapsedMs < 10_000) return "just now";
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`;
  return `${Math.floor(elapsedMs / 86_400_000)}d ago`;
}

function activityStatus(activity: HudActivity): { symbol: string; tone: string } {
  if (activity.state === "failed") return { symbol: "×", tone: COLORS.coral };
  if (activity.state === "working") return { symbol: "○", tone: COLORS.purpleReadable };
  return { symbol: "✓", tone: COLORS.success };
}

function activitySummary(activity: HudActivity): string {
  return [activity.summary.target, ...activity.summary.details].join(" · ");
}

function selectedActivity(state: HudState): HudActivity | undefined {
  if (state.activities.length === 0) return undefined;
  const selected = state.activitySelection
    ? state.activities.find((activity) => activity.requestId === state.activitySelection)
    : undefined;
  return selected ?? state.activities.at(-1);
}

function selectedActivityIndex(state: HudState): number {
  const selected = selectedActivity(state);
  if (!selected) return 0;
  return Math.max(0, state.activities.findIndex((activity) => activity.requestId === selected.requestId));
}

function sectionLabel(value: string): string {
  return value.toUpperCase();
}

const ACCESS_PROFILES: WorkerAccessProfile[] = ["read-only", "workspace", "system"];

function accessProfileLabel(accessProfile: WorkerAccessProfile): string {
  return accessProfile === "read-only"
    ? "Read only"
    : accessProfile === "workspace"
      ? "Workspace"
      : "System";
}

function adjacentAccessProfile(
  accessProfile: WorkerAccessProfile,
  direction: -1 | 1,
): WorkerAccessProfile | undefined {
  const index = ACCESS_PROFILES.indexOf(accessProfile);
  return ACCESS_PROFILES[index + direction];
}

function accessProfileCapabilities(accessProfile: WorkerAccessProfile): {
  summary: string;
  detail: string;
} {
  if (accessProfile === "read-only") {
    return { summary: "Read files only", detail: "No changes · no commands" };
  }
  if (accessProfile === "workspace") {
    return { summary: "Read + write files", detail: "Commands disabled" };
  }
  return {
    summary: "Read + write files + commands",
    detail: "OS account permissions apply",
  };
}

function primaryFooterHints(): HudHint[] {
  return [
    { key: "A", label: "Activity" },
    { key: "W", label: "Workspace" },
    { key: "D", label: "Devices" },
    { key: "?", label: "Help" },
    { key: "Q", label: "Quit", tone: COLORS.coral },
  ];
}


function contextualFooterHints(state: HudState): HudHint[] {
  if (state.view === "activity") {
    return [
      {
        key: "Tab",
        label: state.activityMode === "compact" ? "Detailed" : "Compact",
        labelWidth: "Detailed".length,
      },
      { key: "↑↓", label: "Select" },
      { key: "Enter", label: "Inspect" },
    ];
  }
  if (state.view === "activity-detail") {
    return [
      { key: "↑↓", label: "Scroll" },
      { key: "←", label: "Older" },
      { key: "→", label: "Newer" },
      { key: "Esc", label: "Back" },
    ];
  }
  if (state.view === "devices" && (state.status?.devices.length ?? 0) > 0) {
    return [
      { key: "↑↓", label: "Select" },
      { key: "Enter/R", label: "Revoke", tone: COLORS.coral },
    ];
  }
  if (state.view === "workspace" && state.accessProfile) {
    const displayedAccessProfile = state.pendingAccessProfile ?? state.accessProfile;
    const lower = adjacentAccessProfile(displayedAccessProfile, -1);
    const higher = adjacentAccessProfile(displayedAccessProfile, 1);
    return [
      ...(lower ? [{ key: "←", label: accessProfileLabel(lower) }] : []),
      ...(higher
        ? [{ key: "→", label: accessProfileLabel(higher), tone: COLORS.coral }]
        : []),
    ];
  }
  return [];
}

function footerHintWidth(hint: HudHint): number {
  return hint.key.length + Math.max(hint.label.length, hint.labelWidth ?? 0) + 1;
}

function footerHintsWidth(hints: HudHint[]): number {
  if (hints.length === 0) return 0;
  return hints.reduce((total, hint) => total + footerHintWidth(hint), 0) +
    (hints.length - 1) * 3;
}

function splitFooterHints(hints: HudHint[], usable: number): HudHint[][] {
  if (hints.length === 0) return [];
  const rows: HudHint[][] = [[]];
  let rowLength = 0;
  for (const hint of hints) {
    const tokenLength = footerHintWidth(hint);
    if (rows.at(-1)!.length > 0 && rowLength + 3 + tokenLength > usable) {
      rows.push([]);
      rowLength = 0;
    }
    rows.at(-1)!.push(hint);
    rowLength += (rowLength > 0 ? 3 : 0) + tokenLength;
  }
  return rows;
}

function buildFooterRows(state: HudState, usable: number): HudFooterRow[] {
  const rows = splitFooterHints(primaryFooterHints(), usable).map((left) => ({
    left,
    right: [] as HudHint[],
  }));
  const contextualRows = splitFooterHints(contextualFooterHints(state), usable);
  if (contextualRows.length === 0) return rows;

  const firstContextual = contextualRows[0]!;
  const lastPrimary = rows.at(-1)!;
  const combinedWidth = footerHintsWidth(lastPrimary.left) + 3 +
    footerHintsWidth(firstContextual);
  if (combinedWidth <= usable) {
    lastPrimary.right = firstContextual;
    contextualRows.slice(1).forEach((right) => rows.push({ left: [], right }));
  } else {
    contextualRows.forEach((right) => rows.push({ left: [], right }));
  }
  return rows;
}

function promptText(
  state: HudState,
): { message: string; choices?: string } | undefined {
  if (state.busy) return { message: "Working…" };
  if (!state.prompt) return undefined;
  if (state.prompt.type === "access-confirm") {
    const detail = state.prompt.accessProfile === "system"
      ? "Commands will inherit this OS account's permissions."
      : "This allows guarded file writes.";
    return {
      message: `Increase access to ${accessProfileLabel(state.prompt.accessProfile)}? ${detail}`,
      choices: "Y confirm  N cancel",
    };
  }
  const device = state.status?.devices[state.prompt.deviceIndex];
  return {
    message: `Revoke ${device?.name ?? "this device"}?`,
    choices: "Y confirm  N cancel",
  };
}

function screenMetrics(state: HudState, columns: number, rows: number): HudScreenMetrics {
  const margin = columns >= 24 ? 2 : 0;
  const usable = Math.max(8, columns - margin * 2);
  const terminalRows = Math.max(6, rows);
  const footerRows = buildFooterRows(state, usable);
  const prompt = promptText(state);
  const overlayRows = prompt || state.notice
    ? 2 + (prompt?.choices ? 1 : 0)
    : 0;
  const bodyBudget = Math.max(
    0,
    terminalRows - 2 - overlayRows - 1 - footerRows.length,
  );
  return { usable, bodyBudget, footerRows, overlayRows };
}

function activityListCapacity(bodyBudget: number): number {
  return Math.max(0, bodyBudget - ACTIVITY_PREAMBLE_LINES);
}

function activityWindow(state: HudState, bodyBudget: number): {
  capacity: number;
  selection: number;
  start: number;
  end: number;
} {
  const capacity = activityListCapacity(bodyBudget);
  const total = state.activities.length;
  const selection = total === 0
    ? 0
    : Math.min(selectedActivityIndex(state), total - 1);
  if (capacity <= 0) return { capacity, selection, start: 0, end: 0 };
  const maxStart = Math.max(0, total - capacity);
  const centered = selection - Math.floor(capacity / 2);
  const start = Math.min(maxStart, Math.max(0, centered));
  return {
    capacity,
    selection,
    start,
    end: Math.min(total, start + capacity),
  };
}

function statusDeviceCapacity(state: HudState, bodyBudget: number, usable: number): number {
  if (!state.status || state.statusLoading || state.status.devices.length === 0) return 0;
  const preamble = usable >= 64 ? 10 : 9;
  return Math.min(9, state.status.devices.length, Math.max(0, bodyBudget - preamble));
}

function deviceListWindow(state: HudState, bodyBudget: number, usable: number): {
  capacity: number;
  selection: number;
  start: number;
  end: number;
} {
  const capacity = statusDeviceCapacity(state, bodyBudget, usable);
  const total = state.status?.devices.length ?? 0;
  const selection = total === 0
    ? 0
    : Math.min(Math.max(0, state.deviceSelection), total - 1);
  if (capacity <= 0) return { capacity, selection, start: 0, end: 0 };
  const maxStart = Math.max(0, total - capacity);
  const start = Math.min(maxStart, Math.max(0, selection - capacity + 1));
  return {
    capacity,
    selection,
    start,
    end: Math.min(total, start + capacity),
  };
}

function Line({ usable, color }: { usable: number; color: boolean }): React.ReactNode {
  return (
    <Text color={color ? COLORS.line : undefined} wrap="truncate">
      {"─".repeat(usable)}
    </Text>
  );
}

function Header({ state, usable, bodyBudget, color }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
}): React.ReactNode {
  const statusColor = state.connection === "error" ? COLORS.coral : COLORS.purpleReadable;
  const selected = selectedActivity(state);
  const pageTitle = state.view === "activity"
    ? "Activity"
    : state.view === "activity-detail"
      ? `Activity / ${selected ? activityToolTitle(selected.tool) : "Call"}`
      : state.view === "devices"
        ? "Devices"
        : state.view === "workspace"
          ? "Workspace"
          : state.view === "help"
            ? "Help"
            : undefined;
  const activityListWindow = state.view === "activity"
    ? activityWindow(state, bodyBudget)
    : undefined;
  const activityRange = activityListWindow &&
      activityListWindow.capacity > 0 && state.activities.length > activityListWindow.capacity
    ? ` (${activityListWindow.start + 1}-${activityListWindow.end}/${state.activities.length})`
    : "";
  const deviceWindow = state.view === "devices"
    ? deviceListWindow(state, bodyBudget, usable)
    : undefined;
  const deviceRange = deviceWindow && state.status &&
      deviceWindow.capacity > 0 && state.status.devices.length > deviceWindow.capacity
    ? ` (${deviceWindow.start + 1}-${deviceWindow.end}/${state.status.devices.length})`
    : "";
  return (
    <Box flexDirection="column" height={2} flexShrink={0}>
      <Box width={usable}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate">
            <Text bold color={color ? COLORS.purple : undefined}>Glossa</Text>
            {pageTitle ? (
              <>
                <Text color={color ? COLORS.muted : undefined}> / </Text>
                <Text bold color={color ? COLORS.purpleReadable : undefined}>{pageTitle}</Text>
                {activityRange || deviceRange ? (
                  <Text color={color ? COLORS.muted : undefined}>{activityRange || deviceRange}</Text>
                ) : null}
              </>
            ) : null}
          </Text>
        </Box>
        <Box marginLeft={1} flexShrink={0}>
          <Text bold color={color ? statusColor : undefined}>{connectionLabel(state)}</Text>
        </Box>
      </Box>
      <Line usable={usable} color={color} />
    </Box>
  );
}

function SectionTitle({ children, color, tone = COLORS.purpleReadable }: {
  children: string;
  color: boolean;
  tone?: string;
}): React.ReactNode {
  return <Text bold color={color ? tone : undefined}>{sectionLabel(children)}</Text>;
}

function Blank(): React.ReactNode {
  return <Box height={1} />;
}

function ActivityPreviewHeader({ usable, color }: {
  usable: number;
  color: boolean;
}): React.ReactNode {
  return (
    <Box width={usable}>
      <Box flexGrow={1} flexShrink={1}>
        <SectionTitle color={color}>Activity</SectionTitle>
      </Box>
      {usable >= 24 ? (
        <Box marginLeft={1} flexShrink={0}>
          <Text bold color={color ? COLORS.purpleReadable : undefined}>A</Text>
          <Text color={color ? COLORS.muted : undefined}> View all</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AccessSectionTitle({ accessProfile, usable, color }: {
  accessProfile: WorkerAccessProfile;
  usable: number;
  color: boolean;
}): React.ReactNode {
  const lower = adjacentAccessProfile(accessProfile, -1);
  const higher = adjacentAccessProfile(accessProfile, 1);
  const key = lower && higher ? "←/→" : lower ? "←" : "→";
  return (
    <Box width={usable}>
      <SectionTitle color={color}>Access</SectionTitle>
      {usable >= 24 ? (
        <Box marginLeft={3} flexShrink={0}>
          <Box width={3} flexShrink={0}>
            <Text bold color={color ? COLORS.purpleReadable : undefined}>{key}</Text>
          </Box>
          <Text color={color ? COLORS.muted : undefined}> Switch</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function activityLayout(usable: number, selectable: boolean): {
  toolWidth: number;
  showSummary: boolean;
  showAge: boolean;
  summaryWidth: number;
} {
  const selectorWidth = selectable ? ACTIVITY_SELECTOR_COLUMN_WIDTH : 0;
  const leadingWidth = selectorWidth + ACTIVITY_STATUS_COLUMN_WIDTH;
  const toolWidth = Math.min(
    ACTIVITY_TOOL_COLUMN_WIDTH,
    Math.max(0, usable - leadingWidth),
  );
  const showSummary = usable >= leadingWidth + toolWidth + 5;
  const showAge = usable >= leadingWidth + toolWidth + ACTIVITY_AGE_COLUMN_WIDTH + 10;
  const summaryWidth = Math.max(
    0,
    usable - leadingWidth - toolWidth - (showSummary ? 2 : 0) -
      (showAge ? ACTIVITY_AGE_COLUMN_WIDTH + 2 : 0),
  );
  return { toolWidth, showSummary, showAge, summaryWidth };
}

function WorkspaceView({ state, usable, bodyBudget, color, now }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const displayedAccessProfile = state.pendingAccessProfile ?? state.accessProfile;
  const showConnectionMessage = Boolean(
    state.message && (state.connection === "retrying" || state.connection === "error"),
  );
  let fixedLines = 3;
  if (displayedAccessProfile) fixedLines += 5;
  if (state.deviceName) fixedLines += 3;
  if (showConnectionMessage) fixedLines += 2;
  const activityCapacity = Math.min(3, Math.max(0, bodyBudget - fixedLines - 2));
  const activityPreview = activityCapacity > 0
    ? state.activities.slice(-activityCapacity)
    : [];

  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Workspace</SectionTitle>
      <Text color={color ? COLORS.ink : undefined} wrap="truncate-middle">{state.workspace}</Text>
      {displayedAccessProfile ? (
        <>
          <Blank />
          <AccessSectionTitle
            accessProfile={displayedAccessProfile}
            usable={usable}
            color={color}
          />
          <Text bold color={color ? COLORS.ink : undefined} wrap="truncate">
            {accessProfileLabel(displayedAccessProfile)}
          </Text>
          <Text color={color ? COLORS.muted : undefined} wrap="truncate">
            {accessProfileCapabilities(displayedAccessProfile).summary}
          </Text>
          <Text color={color ? COLORS.muted : undefined} wrap="truncate">
            {accessProfileCapabilities(displayedAccessProfile).detail}
          </Text>
        </>
      ) : null}
      {state.deviceName ? (
        <>
          <Blank />
          <SectionTitle color={color}>Device</SectionTitle>
          <Text color={color ? COLORS.ink : undefined} wrap="truncate">{state.deviceName}</Text>
        </>
      ) : null}
      {activityCapacity > 0 ? (
        <>
          <Blank />
          <ActivityPreviewHeader usable={usable} color={color} />
          {state.activities.length === 0 ? (
            <Text color={color ? COLORS.muted : undefined}>No activity yet.</Text>
          ) : activityPreview.map((activity) => (
            <ActivityRow
              key={activity.requestId}
              activity={activity}
              usable={usable}
              color={color}
              now={now}
            />
          ))}
        </>
      ) : null}
      {showConnectionMessage ? (
        <>
          <Blank />
          <Text color={color ? COLORS.coral : undefined} wrap="truncate">{state.message}</Text>
        </>
      ) : null}
    </Box>
  );
}

function ActivityRow({
  activity,
  usable,
  color,
  now,
  selectable = false,
  selected = false,
  mode = "compact",
}: {
  activity: HudActivity;
  usable: number;
  color: boolean;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  mode?: HudActivityMode;
}): React.ReactNode {
  const { toolWidth, showSummary, showAge, summaryWidth } = activityLayout(usable, selectable);
  const age = activityAge(activity, now);
  const status = activityStatus(activity);
  const summary = activity.call
    ? formatActivityCall(activity.call, mode, summaryWidth)
    : mode === "compact"
      ? activity.compactSummary ?? activitySummary(activity)
      : activitySummary(activity);
  return (
    <Box width={usable} height={1} flexShrink={0}>
      {selectable ? (
        <Box width={ACTIVITY_SELECTOR_COLUMN_WIDTH} flexShrink={0}>
          <Text bold color={color ? COLORS.purpleReadable : undefined}>{selected ? "›" : " "}</Text>
        </Box>
      ) : null}
      <Box width={ACTIVITY_STATUS_COLUMN_WIDTH} flexShrink={0}>
        <Text bold color={color ? status.tone : undefined}>{status.symbol}</Text>
      </Box>
      <Box width={toolWidth} flexShrink={0}>
        <Text
          bold
          color={color ? (selected ? COLORS.purpleReadable : COLORS.ink) : undefined}
          wrap="truncate"
        >
          {activity.tool}
        </Text>
      </Box>
      {showSummary ? (
        <Box marginLeft={2} flexGrow={1} flexShrink={1}>
          <Text color={color ? COLORS.muted : undefined} wrap="truncate">
            {summary}
          </Text>
        </Box>
      ) : null}
      {showAge ? (
        <Box
          width={ACTIVITY_AGE_COLUMN_WIDTH}
          marginLeft={2}
          flexShrink={0}
          justifyContent="flex-end"
        >
          <Text color={color ? COLORS.muted : undefined}>{age}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ActivityView({ state, usable, bodyBudget, color, now }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const window = activityWindow(state, bodyBudget);
  const visible = window.capacity > 0
    ? state.activities.slice(window.start, window.end)
    : [];
  const selection = selectedActivity(state)?.requestId;

  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      {state.activities.length === 0 ? (
        <Text color={color ? COLORS.muted : undefined}>No activity yet.</Text>
      ) : visible.map((activity) => (
        <ActivityRow
          key={activity.requestId}
          activity={activity}
          usable={usable}
          color={color}
          now={now}
          selectable
          selected={activity.requestId === selection}
          mode={state.activityMode}
        />
      ))}
    </Box>
  );
}

interface HudDetailLine {
  section?: string;
  label?: string;
  value?: string;
  tone?: string;
  bold?: boolean;
}

function wrapDetailValue(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const characters = Array.from(value);
  if (characters.length <= width) return [value];
  const lines: string[] = [];
  let remaining = characters;
  while (remaining.length > width) {
    let cut = width;
    for (let index = width - 1; index >= Math.floor(width * 0.55); index -= 1) {
      if (remaining[index] === " ") {
        cut = index;
        break;
      }
    }
    lines.push(remaining.slice(0, cut).join(""));
    remaining = remaining.slice(cut);
    while (remaining[0] === " ") remaining = remaining.slice(1);
  }
  if (remaining.length > 0) lines.push(remaining.join(""));
  return lines;
}

function detailFieldLines(label: string, value: string, usable: number): HudDetailLine[] {
  const labelWidth = Math.min(14, Math.max(8, Math.floor(usable * 0.3)));
  const valueWidth = Math.max(1, usable - labelWidth);
  return wrapDetailValue(value, valueWidth).map((part, index) => ({
    label: index === 0 ? label : "",
    value: part,
  }));
}

function activityStateLabel(activity: HudActivity): string {
  if (activity.state === "working") return "Working";
  if (activity.state === "failed") return "Failed";
  return "Completed";
}

function activityStateTone(activity: HudActivity): string {
  if (activity.state === "working") return COLORS.purpleReadable;
  if (activity.state === "failed") return COLORS.coral;
  return COLORS.success;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function activityDetailLines(activity: HudActivity, usable: number, now: number): HudDetailLine[] {
  const lines: HudDetailLine[] = [
    {},
    { section: "Call" },
    { value: activity.tool, bold: true },
  ];
  if (activity.call) {
    for (const field of activityCallDetailFields(activity.call)) {
      lines.push(...detailFieldLines(field.label, field.value, usable));
    }
  } else {
    const reason = activity.callUnavailable === "oversized"
      ? "Full invocation metadata exceeded the local Activity detail budget and was not retained."
      : "Full invocation metadata has expired from the local Activity detail budget; the compact history remains available.";
    lines.push(...detailFieldLines("details", reason, usable));
  }

  lines.push({}, { section: "Status" });
  lines.push(...detailFieldLines("state", activityStateLabel(activity), usable).map((line) => ({
    ...line,
    tone: activityStateTone(activity),
    bold: true,
  })));
  if (activity.startedAt !== undefined) {
    lines.push(...detailFieldLines("started", formatClock(activity.startedAt), usable));
    if (activity.state !== "working" && activity.updatedAt !== undefined) {
      lines.push(...detailFieldLines("finished", formatClock(activity.updatedAt), usable));
    }
    const end = activity.state === "working" ? now : activity.updatedAt ?? now;
    lines.push(...detailFieldLines("duration", liveDuration(end - activity.startedAt), usable));
  }
  lines.push(...detailFieldLines("request", activity.requestId, usable));
  return lines;
}

function ActivityDetailLine({ line, usable, color }: {
  line: HudDetailLine;
  usable: number;
  color: boolean;
}): React.ReactNode {
  if (line.section) return <SectionTitle color={color}>{line.section}</SectionTitle>;
  if (line.label === undefined && line.value === undefined) return <Blank />;
  const labelWidth = Math.min(14, Math.max(8, Math.floor(usable * 0.3)));
  return (
    <Box width={usable} height={1} flexShrink={0}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={color ? COLORS.muted : undefined}>{line.label ?? ""}</Text>
      </Box>
      <Text
        bold={Boolean(line.bold)}
        color={color ? (line.tone ?? COLORS.ink) : undefined}
        wrap="truncate"
      >
        {line.value ?? ""}
      </Text>
    </Box>
  );
}

function ActivityDetailView({ state, usable, bodyBudget, color, now }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const activity = selectedActivity(state);
  if (!activity) {
    return (
      <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
        <Blank />
        <Text color={color ? COLORS.muted : undefined}>No activity selected.</Text>
      </Box>
    );
  }
  const lines = activityDetailLines(activity, usable, now);
  const maxScroll = Math.max(0, lines.length - bodyBudget);
  const scroll = Math.min(state.activityDetailScroll, maxScroll);
  const visible = lines.slice(scroll, scroll + bodyBudget);
  const remaining = Math.max(0, bodyBudget - visible.length);
  const previewCapacity = maxScroll === 0 ? Math.min(3, Math.max(0, remaining - 2)) : 0;
  const preview = previewCapacity > 0 ? state.activities.slice(-previewCapacity) : [];

  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      {visible.map((line, index) => (
        <ActivityDetailLine key={`${scroll}-${index}`} line={line} usable={usable} color={color} />
      ))}
      {previewCapacity > 0 ? (
        <>
          <Blank />
          <ActivityPreviewHeader usable={usable} color={color} />
          {preview.map((recent) => (
            <ActivityRow
              key={recent.requestId}
              activity={recent}
              usable={usable}
              color={color}
              now={now}
              mode="compact"
            />
          ))}
        </>
      ) : null}
    </Box>
  );
}

function activityDetailMaxScroll(state: HudState, usable: number, bodyBudget: number, now: number): number {
  const activity = selectedActivity(state);
  if (!activity) return 0;
  return Math.max(0, activityDetailLines(activity, usable, now).length - bodyBudget);
}

function Metric({ value, label, color }: {
  value: string;
  label: string;
  color: boolean;
}): React.ReactNode {
  return (
    <Box>
      <Text color={color ? COLORS.ink : undefined}>{value}</Text>
      <Text color={color ? COLORS.muted : undefined}> {label}</Text>
    </Box>
  );
}

function DeviceRow({ device, selected, usable, color }: {
  device: HudDevice;
  selected: boolean;
  usable: number;
  color: boolean;
}): React.ReactNode {
  const active = device.status.includes("active");
  const tone = active ? COLORS.purpleReadable : COLORS.muted;
  const selector = selected ? "›" : " ";
  if (usable < 64) {
    return (
      <Box width={usable}>
        <Box width={2} flexShrink={0}>
          <Text bold color={color ? COLORS.purpleReadable : undefined}>{selector}</Text>
        </Box>
        <Text
          bold={selected}
          color={color ? (selected ? COLORS.purpleReadable : tone) : undefined}
          wrap="truncate"
        >
          {`${device.name} · ${device.status} · ${device.platform} · ${device.lastSeen}`}
        </Text>
      </Box>
    );
  }
  return (
    <Box width={usable}>
      <Box width={2} flexShrink={0}>
        <Text bold color={color ? COLORS.purpleReadable : undefined}>{selector}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text
          bold={selected}
          color={color ? (selected ? COLORS.purpleReadable : COLORS.ink) : undefined}
          wrap="truncate"
        >
          {device.name}
        </Text>
      </Box>
      <Box width={18} flexShrink={0}>
        <Text color={color ? tone : undefined} wrap="truncate">{device.status}</Text>
      </Box>
      <Box width={14} flexShrink={0}>
        <Text color={color ? COLORS.muted : undefined} wrap="truncate">{device.platform}</Text>
      </Box>
      <Box width={18} flexShrink={0}>
        <Text color={color ? COLORS.muted : undefined} wrap="truncate">{device.lastSeen}</Text>
      </Box>
    </Box>
  );
}

function DeviceHeading({ usable, color }: { usable: number; color: boolean }): React.ReactNode {
  if (usable < 64) return null;
  return (
    <Box width={usable}>
      <Box width={2} />
      <Box flexGrow={1}><Text color={color ? COLORS.muted : undefined}>Device</Text></Box>
      <Box width={18}><Text color={color ? COLORS.muted : undefined}>Workers</Text></Box>
      <Box width={14}><Text color={color ? COLORS.muted : undefined}>Platform</Text></Box>
      <Box width={18}><Text color={color ? COLORS.muted : undefined}>Last seen</Text></Box>
    </Box>
  );
}

function DevicesView({ state, usable, bodyBudget, color }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
}): React.ReactNode {
  const window = deviceListWindow(state, bodyBudget, usable);
  const devices = state.status?.devices.slice(window.start, window.end) ?? [];
  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Paired</SectionTitle>
      {state.statusLoading ? (
        <>
          <Blank />
          <Text color={color ? COLORS.muted : undefined}>Loading devices…</Text>
        </>
      ) : !state.status ? (
        <>
          <Blank />
          <Text color={color ? COLORS.muted : undefined}>Devices are not loaded.</Text>
        </>
      ) : (
        <>
          <Text color={color ? COLORS.ink : undefined} wrap="truncate">{state.deviceName ?? "This computer"}</Text>
          <Text color={color ? COLORS.muted : undefined} wrap="truncate">{state.status.relay}</Text>
          <Blank />
          <SectionTitle color={color}>Overview</SectionTitle>
          <Metric
            value={state.status.activeWorkers === null ? "Unavailable" : String(state.status.activeWorkers)}
            label="Active workspaces"
            color={color}
          />
          <Metric value={String(state.status.devices.length)} label="Devices" color={color} />
          <Blank />
          {state.status.devices.length === 0 ? (
            <Text color={color ? COLORS.muted : undefined}>No devices.</Text>
          ) : (
            <>
              <DeviceHeading usable={usable} color={color} />
              {devices.map((device, index) => {
                const deviceIndex = window.start + index;
                return (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    selected={deviceIndex === window.selection}
                    usable={usable}
                    color={color}
                  />
                );
              })}
            </>
          )}
        </>
      )}
    </Box>
  );
}

function HelpRow({ keyLabel, label, color, tone = COLORS.purpleReadable }: {
  keyLabel: string;
  label: string;
  color: boolean;
  tone?: string;
}): React.ReactNode {
  return (
    <Box>
      <Box width={8} flexShrink={0}>
        <Text bold color={color ? tone : undefined}>{keyLabel}</Text>
      </Box>
      <Text color={color ? COLORS.muted : undefined} wrap="truncate">{label}</Text>
    </Box>
  );
}

function HelpView({ bodyBudget, color }: { bodyBudget: number; color: boolean }): React.ReactNode {
  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Navigate</SectionTitle>
      <HelpRow keyLabel="A" label="Activity" color={color} />
      <HelpRow keyLabel="W" label="Workspace" color={color} />
      <HelpRow keyLabel="D" label="Devices" color={color} />
      <HelpRow keyLabel="?" label="Help" color={color} />
      <HelpRow keyLabel="Esc" label="Workspace" color={color} />
      <Blank />
      <SectionTitle color={color} tone={COLORS.coral}>Manage</SectionTitle>
      <HelpRow keyLabel="←/→" label="Change workspace access" color={color} tone={COLORS.coral} />
      <HelpRow keyLabel="Enter/R" label="Revoke selected device" color={color} tone={COLORS.coral} />
      <Blank />
      <SectionTitle color={color}>App</SectionTitle>
      <HelpRow keyLabel="Q" label="Disconnect and quit" color={color} tone={COLORS.coral} />
      <HelpRow keyLabel="Ctrl+C" label="Disconnect and quit" color={color} tone={COLORS.coral} />
    </Box>
  );
}

function Overlay({ state, usable, color }: {
  state: HudState;
  usable: number;
  color: boolean;
}): React.ReactNode {
  const prompt = promptText(state);
  const message = prompt?.message ?? state.notice;
  if (!message) return null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Line usable={usable} color={color} />
      <Text
        bold={Boolean(prompt)}
        color={color ? COLORS.coral : undefined}
        wrap="truncate"
      >
        {message}
      </Text>
      {prompt?.choices ? (
        <Text color={color ? COLORS.muted : undefined} wrap="truncate">{prompt.choices}</Text>
      ) : null}
    </Box>
  );
}

function FooterHintGroup({ hints, color }: {
  hints: HudHint[];
  color: boolean;
}): React.ReactNode {
  return hints.map((hint, index) => (
    <React.Fragment key={`${hint.key}-${hint.label}`}>
      {index > 0 ? <Text>   </Text> : null}
      <Text bold color={color ? (hint.tone ?? COLORS.purpleReadable) : undefined}>
        {hint.key}
      </Text>
      <Text color={color ? COLORS.muted : undefined}>
        {` ${hint.label.padEnd(Math.max(hint.label.length, hint.labelWidth ?? 0))}`}
      </Text>
    </React.Fragment>
  ));
}

function Footer({ rows, usable, color }: {
  rows: HudFooterRow[];
  usable: number;
  color: boolean;
}): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Line usable={usable} color={color} />
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} width={usable}>
          <Box flexShrink={0}>
            <FooterHintGroup hints={row.left} color={color} />
          </Box>
          {row.right.length > 0 ? (
            <Box flexGrow={1} justifyContent="flex-end" marginLeft={row.left.length > 0 ? 1 : 0}>
              <FooterHintGroup hints={row.right} color={color} />
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function HudScreen({ state, columns, rows, color = true, now = Date.now() }: {
  state: HudState;
  columns: number;
  rows: number;
  color?: boolean;
  now?: number;
}): React.ReactNode {
  const margin = columns >= 24 ? 2 : 0;
  const metrics = screenMetrics(state, columns, rows);
  const inner = (
    <Box width={metrics.usable} height={Math.max(6, rows)} flexDirection="column">
      <Header
        state={state}
        usable={metrics.usable}
        bodyBudget={metrics.bodyBudget}
        color={color}
      />
      {state.view === "activity" ? (
        <ActivityView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
          now={now}
        />
      ) : state.view === "activity-detail" ? (
        <ActivityDetailView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
          now={now}
        />
      ) : state.view === "devices" ? (
        <DevicesView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
        />
      ) : state.view === "workspace" ? (
        <WorkspaceView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
          now={now}
        />
      ) : (
        <HelpView bodyBudget={metrics.bodyBudget} color={color} />
      )}
      <Overlay state={state} usable={metrics.usable} color={color} />
      <Footer rows={metrics.footerRows} usable={metrics.usable} color={color} />
    </Box>
  );
  return (
    <Box width={Math.max(8, columns)} height={Math.max(6, rows)} flexDirection="column">
      {margin > 0 ? <Box marginLeft={margin}>{inner}</Box> : inner}
    </Box>
  );
}

export function renderHud(
  state: HudState,
  width = 80,
  color = true,
  height = 24,
  now = Date.now(),
): string {
  const output = renderToString(
    <HudScreen state={state} columns={width} rows={height} color={color} now={now} />,
    { columns: width },
  );
  return color ? output : stripVTControlCharacters(output);
}

async function loadDevices(
  store: HudStore,
  actions: HudUiActions,
  signal: AbortSignal,
): Promise<void> {
  const current = store.getSnapshot();
  store.update((state) => ({
    ...state,
    view: "devices",
    prompt: undefined,
    notice: undefined,
  }));
  if (current.statusLoading) return;
  if (current.connection !== "connected" && current.connection !== "retrying") {
    store.update((state) => ({
      ...state,
      notice: "Devices are available after Glossa connects.",
    }));
    return;
  }
  store.update((state) => ({
    ...state,
    statusLoading: true,
  }));
  try {
    const status = await actions.loadStatus(signal);
    if (signal.aborted) return;
    store.update((state) => ({
      ...state,
      status,
      deviceSelection: Math.min(
        state.deviceSelection,
        Math.max(0, status.devices.length - 1),
      ),
      statusLoading: false,
    }));
  } catch (error) {
    if (signal.aborted) return;
    store.update((state) => ({
      ...state,
      statusLoading: false,
      notice: error instanceof Error ? error.message : String(error),
    }));
  }
}

function beginAccessChange(
  store: HudStore,
  actions: HudUiActions,
  accessProfile: WorkerAccessProfile,
): void {
  actions.changeAccessProfile(accessProfile);
  store.update((state) => ({
    ...state,
    pendingAccessProfile: accessProfile,
    prompt: undefined,
    notice: undefined,
  }));
}

function HudRuntime({ store, actions, signal, stop }: {
  store: HudStore;
  actions: HudUiActions;
  signal: AbortSignal;
  stop: () => void;
}): React.ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { columns, rows } = useWindowSize();
  const [, setClock] = useState(0);

  useEffect(() => {
    if (
      (state.view !== "activity" && state.view !== "activity-detail" && state.view !== "workspace") ||
      state.activities.length === 0
    ) return;
    const hasWorkingActivity = state.activities.some((activity) => activity.state === "working");
    const interval = hasWorkingActivity
      ? ACTIVITY_LIVE_REFRESH_INTERVAL_MS
      : ACTIVITY_IDLE_REFRESH_INTERVAL_MS;
    const timer = setInterval(() => setClock((value) => value + 1), interval);
    return () => clearInterval(timer);
  }, [state.view, state.activities]);

  useEffect(() => {
    store.update((current) => {
      let next = current;
      const metrics = screenMetrics(current, columns, rows);
      if (current.view === "activity-detail") {
        const maxScroll = activityDetailMaxScroll(
          current,
          metrics.usable,
          metrics.bodyBudget,
          Date.now(),
        );
        if (current.activityDetailScroll > maxScroll) {
          next = { ...next, activityDetailScroll: maxScroll };
        }
      }
      if (current.prompt?.type === "revoke-confirm") {
        const capacity = statusDeviceCapacity(current, metrics.bodyBudget, metrics.usable);
        if (capacity === 0) {
          next = {
            ...next,
            prompt: undefined,
            notice: "Increase the terminal height to choose a device.",
          };
        }
      }
      return next;
    });
  }, [columns, rows, store]);

  useInput((input, key) => {
    const current = store.getSnapshot();
    const value = input.toLowerCase();
    if ((key.ctrl && value === "c") || value === "q") {
      stop();
      return;
    }
    if (current.busy) return;

    if (current.prompt) {
      if (key.escape || value === "n") {
        store.update((state) => ({ ...state, prompt: undefined, notice: undefined }));
        return;
      }
      if (value !== "y") return;
      if (current.prompt.type === "access-confirm") {
        beginAccessChange(store, actions, current.prompt.accessProfile);
        return;
      }
      const device = current.status?.devices[current.prompt.deviceIndex];
      if (!device) return;
      store.update((state) => ({
        ...state,
        busy: true,
        prompt: undefined,
        notice: undefined,
      }));
      void actions.revokeDevice(device.id, signal).then(async () => {
        if (signal.aborted) return;
        store.update((state) => ({ ...state, busy: false }));
        await loadDevices(store, actions, signal);
        if (signal.aborted) return;
        store.update((state) => ({ ...state, notice: `Revoked ${device.name}.` }));
      }).catch((error: unknown) => {
        if (signal.aborted) return;
        store.update((state) => ({
          ...state,
          busy: false,
          notice: error instanceof Error ? error.message : String(error),
        }));
      });
      return;
    }

    if (current.view === "activity-detail") {
      if (key.upArrow || key.downArrow) {
        const metrics = screenMetrics(current, columns, rows);
        const maxScroll = activityDetailMaxScroll(
          current,
          metrics.usable,
          metrics.bodyBudget,
          Date.now(),
        );
        const activityDetailScroll = key.upArrow
          ? Math.max(0, current.activityDetailScroll - 1)
          : Math.min(maxScroll, current.activityDetailScroll + 1);
        if (activityDetailScroll !== current.activityDetailScroll) {
          store.update((state) => ({ ...state, activityDetailScroll }));
        }
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const total = current.activities.length;
        if (total === 0) return;
        const currentIndex = selectedActivityIndex(current);
        const selection = key.leftArrow
          ? Math.max(0, currentIndex - 1)
          : Math.min(total - 1, currentIndex + 1);
        if (selection !== currentIndex) {
          store.update((state) => ({
            ...state,
            activitySelection: state.activities[selection]?.requestId,
            activityFollowTail: selection === total - 1,
            activityDetailScroll: 0,
          }));
        }
        return;
      }
      if (key.escape) {
        store.update((state) => ({
          ...state,
          view: "activity",
          activityDetailScroll: 0,
          notice: undefined,
        }));
        return;
      }
    }
    if (current.view === "activity") {
      if (key.tab || input === "\t") {
        store.update((state) => ({
          ...state,
          activityMode: state.activityMode === "compact" ? "detailed" : "compact",
          notice: undefined,
        }));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const total = current.activities.length;
        if (total === 0) return;
        const currentIndex = selectedActivityIndex(current);
        const selection = key.upArrow
          ? Math.max(0, currentIndex - 1)
          : Math.min(total - 1, currentIndex + 1);
        if (selection !== currentIndex) {
          store.update((state) => ({
            ...state,
            activitySelection: state.activities[selection]?.requestId,
            activityFollowTail: selection === total - 1,
            notice: undefined,
          }));
        }
        return;
      }
      if (key.return || input === "\r" || input === "\n") {
        const selected = selectedActivity(current);
        if (!selected) return;
        store.update((state) => ({
          ...state,
          activitySelection: selected.requestId,
          view: "activity-detail",
          activityDetailScroll: 0,
          notice: undefined,
        }));
        return;
      }
    }
    if (current.view === "devices" && (key.upArrow || key.downArrow)) {
      const total = current.status?.devices.length ?? 0;
      const metrics = screenMetrics(current, columns, rows);
      if (total === 0 || statusDeviceCapacity(current, metrics.bodyBudget, metrics.usable) === 0) {
        return;
      }
      const selection = key.upArrow
        ? Math.max(0, current.deviceSelection - 1)
        : Math.min(total - 1, current.deviceSelection + 1);
      if (selection !== current.deviceSelection) {
        store.update((state) => ({ ...state, deviceSelection: selection, notice: undefined }));
      }
      return;
    }
    if (
      current.view === "workspace" &&
      current.accessProfile &&
      !current.pendingAccessProfile &&
      (key.leftArrow || key.rightArrow)
    ) {
      const direction = key.leftArrow ? -1 : 1;
      const accessProfile = adjacentAccessProfile(current.accessProfile, direction);
      if (!accessProfile) return;
      if (direction < 0) {
        beginAccessChange(store, actions, accessProfile);
      } else {
        store.update((state) => ({
          ...state,
          prompt: { type: "access-confirm", accessProfile },
          notice: undefined,
        }));
      }
      return;
    }

    if (key.escape) {
      store.update((state) => ({ ...state, view: "workspace", notice: undefined }));
      return;
    }
    if (value === "a") {
      const enteringFromAnotherView = current.view !== "activity" && current.view !== "activity-detail";
      store.update((state) => ({
        ...state,
        view: "activity",
        activitySelection: enteringFromAnotherView
          ? state.activities.at(-1)?.requestId
          : selectedActivity(state)?.requestId,
        activityFollowTail: enteringFromAnotherView ? true : state.activityFollowTail,
        activityDetailScroll: 0,
        notice: undefined,
      }));
      return;
    }
    if (value === "w") {
      store.update((state) => ({
        ...state,
        view: "workspace",
        prompt: undefined,
        notice: undefined,
      }));
      return;
    }
    if (value === "d") {
      if (current.status) {
        store.update((state) => ({
          ...state,
          view: "devices",
          prompt: undefined,
          notice: undefined,
        }));
      } else {
        void loadDevices(store, actions, signal);
      }
      return;
    }
    if ((key.return || input === "\r" || input === "\n" || value === "r") && current.view === "devices") {
      const count = current.status?.devices.length ?? 0;
      if (count === 0) {
        store.update((state) => ({ ...state, notice: "There are no devices to revoke." }));
        return;
      }
      const metrics = screenMetrics(current, columns, rows);
      const capacity = statusDeviceCapacity(current, metrics.bodyBudget, metrics.usable);
      const selection = Math.min(current.deviceSelection, count - 1);
      store.update((state) => capacity === 0
        ? { ...state, notice: "Increase the terminal height to choose a device." }
        : {
            ...state,
            deviceSelection: selection,
            prompt: { type: "revoke-confirm", deviceIndex: selection },
            notice: undefined,
          });
      return;
    }
    if (input === "?") {
      store.update((state) => ({
        ...state,
        view: "help",
        notice: undefined,
      }));
    }
  });

  return (
    <HudScreen
      state={state}
      columns={columns}
      rows={rows}
      color={!process.env.NO_COLOR}
      now={Date.now()}
    />
  );
}

export async function runSessionHud(
  actions: HudUiActions,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Glossa requires an interactive terminal.");
  }

  const controller = new AbortController();
  const store = new HudStore(actions.workspace, actions.initialNotice);
  let instance: ReturnType<typeof render> | undefined;

  const stop = (): void => {
    controller.abort();
    instance?.unmount();
  };
  const stopFromSignal = (): void => stop();
  process.once("SIGINT", stopFromSignal);
  process.once("SIGTERM", stopFromSignal);

  output.write(terminalTitleSequence(actions.workspaceLabel));
  instance = render(
    <HudRuntime
      store={store}
      actions={actions}
      signal={controller.signal}
      stop={stop}
    />,
    {
      stdin: input,
      stdout: output,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
      incrementalRendering: true,
      interactive: true,
      maxFps: 30,
    },
  );

  const session = actions.run(controller.signal, (event) => store.event(event)).then(() => {
    if (!controller.signal.aborted) {
      store.update((state) => ({ ...state, connection: "disconnected" }));
    }
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) {
      store.update((state) => ({
        ...state,
        connection: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
      instance?.unmount();
    }
    throw error;
  });
  void session.catch(() => undefined);

  try {
    await instance.waitUntilExit();
    await session;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stopFromSignal);
    process.removeListener("SIGTERM", stopFromSignal);
  }
}
