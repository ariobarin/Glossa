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

import { formatRelativeTime } from "./device-format.js";
import {
  applyHudEvent,
  initialHudState,
  type HudActivity,
  type HudDevice,
  type HudState,
  type HudUiActions,
} from "./ui-hud-model.js";

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

const ACTIVITY_REFRESH_INTERVAL_MS = 10_000;
const DEVICE_REFRESH_INTERVAL_MS = 10_000;
const ACTIVITY_STATUS_COLUMN_WIDTH = 2;
const ACTIVITY_TOOL_COLUMN_WIDTH = 15;
const ACTIVITY_AGE_COLUMN_WIDTH = 10;
const ACTIVITY_PREAMBLE_LINES = 1;

interface HudHint {
  key: string;
  label: string;
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

  constructor(workspace: string) {
    this.#state = initialHudState(workspace);
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

function activityAge(updatedAt: number | undefined, working: boolean, now: number): string {
  if (working) return "now";
  if (updatedAt === undefined) return "";
  const elapsedMs = Math.max(0, now - updatedAt);
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
      { key: "↑", label: "Older" },
      { key: "↓", label: "Newer" },
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
  return hint.key.length + hint.label.length + 1;
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

function activityPageCapacity(bodyBudget: number): number {
  return Math.max(0, bodyBudget - ACTIVITY_PREAMBLE_LINES);
}

function activityMaxPage(activityCount: number, pageCapacity: number): number {
  if (pageCapacity <= 0 || activityCount <= pageCapacity) return 0;
  return Math.floor((activityCount - 1) / pageCapacity);
}

function activityPageInfo(state: HudState, bodyBudget: number): {
  capacity: number;
  maxPage: number;
  page: number;
  rangeStart: number;
  rangeEnd: number;
} {
  const capacity = activityPageCapacity(bodyBudget);
  const maxPage = activityMaxPage(state.activities.length, capacity);
  const page = Math.min(state.activityPage, maxPage);
  return {
    capacity,
    maxPage,
    page,
    rangeStart: page * capacity + 1,
    rangeEnd: Math.min((page + 1) * capacity, state.activities.length),
  };
}

function statusDeviceCapacity(state: HudState, bodyBudget: number, usable: number): number {
  if (!state.status || state.status.devices.length === 0) return 0;
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
  const pageTitle = state.view === "activity"
    ? "Activity"
    : state.view === "devices"
      ? "Devices"
      : state.view === "workspace"
        ? "Workspace"
        : state.view === "help"
          ? "Help"
          : undefined;
  const activityPage = state.view === "activity"
    ? activityPageInfo(state, bodyBudget)
    : undefined;
  const activityRange = activityPage && activityPage.maxPage > 0
    ? ` (${activityPage.rangeStart}-${activityPage.rangeEnd}/${state.activities.length})`
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
          <Text bold color={color ? COLORS.purpleReadable : undefined}>{key}</Text>
          <Text color={color ? COLORS.muted : undefined}> Switch</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function activityLayout(usable: number): {
  toolWidth: number;
  showSummary: boolean;
  showAge: boolean;
} {
  const toolWidth = Math.min(
    ACTIVITY_TOOL_COLUMN_WIDTH,
    Math.max(0, usable - ACTIVITY_STATUS_COLUMN_WIDTH),
  );
  return {
    toolWidth,
    showSummary: usable >= ACTIVITY_STATUS_COLUMN_WIDTH + toolWidth + 5,
    showAge: usable >=
      ACTIVITY_STATUS_COLUMN_WIDTH + toolWidth + ACTIVITY_AGE_COLUMN_WIDTH + 10,
  };
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

function ActivityRow({ activity, usable, color, now }: {
  activity: HudActivity;
  usable: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const { toolWidth, showSummary, showAge } = activityLayout(usable);
  const age = activityAge(activity.updatedAt, activity.state === "working", now);
  const status = activityStatus(activity);
  return (
    <Box width={usable} height={1} flexShrink={0}>
      <Box width={ACTIVITY_STATUS_COLUMN_WIDTH} flexShrink={0}>
        <Text bold color={color ? status.tone : undefined}>{status.symbol}</Text>
      </Box>
      <Box width={toolWidth} flexShrink={0}>
        <Text
          bold
          color={color ? COLORS.ink : undefined}
          wrap="truncate"
        >
          {activity.tool}
        </Text>
      </Box>
      {showSummary ? (
        <Box marginLeft={2} flexGrow={1} flexShrink={1}>
          <Text color={color ? COLORS.muted : undefined} wrap="truncate-middle">
            {activitySummary(activity)}
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
  const { capacity, page } = activityPageInfo(state, bodyBudget);
  const pageEnd = state.activities.length - page * capacity;
  const pageStart = Math.max(0, pageEnd - capacity);
  const visible = capacity > 0 ? state.activities.slice(pageStart, pageEnd) : [];

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
        />
      ))}
    </Box>
  );
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

function DeviceRow({ device, selected, usable, color, now }: {
  device: HudDevice;
  selected: boolean;
  usable: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const active = device.status.includes("active");
  const lastSeen = formatRelativeTime(device.lastSeenAt, now);
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
          {`${device.name} · ${device.status} · ${device.platform} · ${lastSeen}`}
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
        <Text color={color ? COLORS.muted : undefined} wrap="truncate">{lastSeen}</Text>
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

function DevicesView({ state, usable, bodyBudget, color, now }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
  now: number;
}): React.ReactNode {
  const window = deviceListWindow(state, bodyBudget, usable);
  const devices = state.status?.devices.slice(window.start, window.end) ?? [];
  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Paired</SectionTitle>
      {state.statusLoading && !state.status ? (
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
                    now={now}
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
      <Text color={color ? COLORS.muted : undefined}> {hint.label}</Text>
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
      ) : state.view === "devices" ? (
        <DevicesView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
          now={now}
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
      (state.view !== "activity" && state.view !== "workspace") ||
      state.activities.length === 0
    ) return;
    const timer = setInterval(() => setClock((value) => value + 1), ACTIVITY_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.view, state.activities.length]);

  useEffect(() => {
    if (state.view !== "devices" || state.prompt || state.busy) return;
    const timer = setInterval(() => {
      void loadDevices(store, actions, signal);
    }, DEVICE_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [actions, signal, state.busy, state.prompt, state.view, store]);

  useEffect(() => {
    store.update((current) => {
      let next = current;
      const metrics = screenMetrics(current, columns, rows);
      if (current.view === "activity") {
        const capacity = activityPageCapacity(metrics.bodyBudget);
        const maxPage = activityMaxPage(current.activities.length, capacity);
        if (current.activityPage > maxPage) {
          next = { ...next, activityPage: maxPage };
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

    if (current.view === "activity" && (key.upArrow || key.downArrow)) {
      const metrics = screenMetrics(current, columns, rows);
      const capacity = activityPageCapacity(metrics.bodyBudget);
      const maxPage = activityMaxPage(current.activities.length, capacity);
      const page = key.upArrow
        ? Math.min(maxPage, current.activityPage + 1)
        : Math.max(0, current.activityPage - 1);
      if (page !== current.activityPage) {
        store.update((state) => ({ ...state, activityPage: page }));
      }
      return;
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
      store.update((state) => ({
        ...state,
        view: "activity",
        activityPage: current.view === "activity" ? state.activityPage : 0,
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
      void loadDevices(store, actions, signal);
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
  const store = new HudStore(actions.workspace);
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
