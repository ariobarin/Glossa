import type { ReadStream, WriteStream } from "node:tty";
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
import { accessProfileSummary } from "./worker/managed-session.js";
import {
  applyHudEvent,
  initialHudState,
  type HudActivity,
  type HudDevice,
  type HudExitAction,
  type HudState,
  type HudUiActions,
} from "./ui-hud-model.js";

const COLORS = {
  ink: "#f4f1fb",
  muted: "#aaa4b5",
  purple: "#8054ff",
  purpleReadable: "#ad98ff",
  coral: "#ff665f",
  orange: "#ffa657",
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
const ACTIVITY_TOOL_COLUMN_WIDTH = 15;
const ACTIVITY_PREAMBLE_LINES = 1;

interface HudHint {
  key: string;
  label: string;
  tone?: string;
}

interface HudScreenMetrics {
  usable: number;
  bodyBudget: number;
  footerRows: HudHint[][];
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

function activityColor(activity: HudActivity): string {
  if (activity.state === "working") return COLORS.ink;
  if (activity.state === "failed") return COLORS.orange;
  return COLORS.purpleReadable;
}

function activitySummary(activity: HudActivity): string {
  return [activity.summary.target, ...activity.summary.details].join(" · ");
}

function sectionLabel(value: string): string {
  return value.toUpperCase();
}

function footerHints(state: HudState): HudHint[] {
  if (state.view === "status") {
    return [
      { key: "R", label: "Revoke", tone: COLORS.coral },
      { key: "L", label: "Sign out", tone: COLORS.coral },
      { key: "Esc", label: "Session" },
      { key: "Q", label: "Quit", tone: COLORS.coral },
    ];
  }
  if (state.view === "activity") {
    return [
      { key: "↑", label: "Older" },
      { key: "↓", label: "Newer" },
      { key: "D", label: "Session" },
      { key: "S", label: "Status" },
      { key: "?", label: "Help" },
      { key: "Q", label: "Quit", tone: COLORS.coral },
    ];
  }
  if (state.view === "help") {
    return [
      { key: "?", label: "Session" },
      { key: "Q", label: "Quit", tone: COLORS.coral },
    ];
  }
  return [
    { key: "D", label: "Recent activity" },
    { key: "S", label: "Status" },
    { key: "?", label: "Help" },
    { key: "L", label: "Sign out", tone: COLORS.coral },
    { key: "Q", label: "Quit", tone: COLORS.coral },
  ];
}

function splitFooterHints(state: HudState, usable: number): HudHint[][] {
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
  return rows;
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

function screenMetrics(state: HudState, columns: number, rows: number): HudScreenMetrics {
  const margin = columns >= 24 ? 2 : 0;
  const usable = Math.max(8, columns - margin * 2);
  const terminalRows = Math.max(6, rows);
  const footerRows = splitFooterHints(state, usable);
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
  if (!state.status || state.statusLoading || state.status.devices.length === 0) return 0;
  const preamble = usable >= 64 ? 11 : 10;
  return Math.min(9, state.status.devices.length, Math.max(0, bodyBudget - preamble));
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
    ? "Recent Activity"
    : state.view === "status"
      ? "Status"
      : state.view === "help"
        ? "Help"
        : undefined;
  const activityPage = state.view === "activity"
    ? activityPageInfo(state, bodyBudget)
    : undefined;
  const activityRange = activityPage && activityPage.maxPage > 0
    ? ` (${activityPage.rangeStart}-${activityPage.rangeEnd}/${state.activities.length})`
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
                {activityRange ? (
                  <Text color={color ? COLORS.muted : undefined}>{activityRange}</Text>
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

function SessionView({ state, bodyBudget, color }: {
  state: HudState;
  bodyBudget: number;
  color: boolean;
}): React.ReactNode {
  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Workspace</SectionTitle>
      <Text color={color ? COLORS.ink : undefined} wrap="truncate-middle">{state.workspace}</Text>
      {state.accessProfile ? (
        <>
          <Blank />
          <SectionTitle color={color}>Access</SectionTitle>
          <Text color={color ? COLORS.ink : undefined} wrap="truncate">
            {accessProfileSummary(state.accessProfile)}
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
      {state.message && (state.connection === "retrying" || state.connection === "error") ? (
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
  const toolWidth = Math.min(ACTIVITY_TOOL_COLUMN_WIDTH, usable);
  const age = activityAge(activity.updatedAt, activity.state === "working", now);
  const showAge = usable >= toolWidth + age.length + 10;
  const showSummary = usable >= toolWidth + 5;
  return (
    <Box width={usable} height={1} flexShrink={0}>
      <Box width={toolWidth} flexShrink={0}>
        <Text
          bold
          color={color ? activityColor(activity) : undefined}
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
        <Box marginLeft={2} flexShrink={0}>
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

function DeviceRow({ device, index, usable, color }: {
  device: HudDevice;
  index: number;
  usable: number;
  color: boolean;
}): React.ReactNode {
  const active = device.status.includes("active");
  const tone = active ? COLORS.purpleReadable : COLORS.muted;
  if (usable < 64) {
    return (
      <Box width={usable}>
        <Box width={4} flexShrink={0}>
          <Text bold color={color ? COLORS.purpleReadable : undefined}>{String(index + 1).padStart(2)}</Text>
        </Box>
        <Text color={color ? tone : undefined} wrap="truncate">
          {`${device.name} · ${device.status} · ${device.platform} · ${device.lastSeen}`}
        </Text>
      </Box>
    );
  }
  return (
    <Box width={usable}>
      <Box width={4} flexShrink={0}>
        <Text bold color={color ? COLORS.purpleReadable : undefined}>{String(index + 1).padStart(2)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={color ? COLORS.ink : undefined} wrap="truncate">{device.name}</Text>
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
      <Box width={4} />
      <Box flexGrow={1}><Text color={color ? COLORS.muted : undefined}>Device</Text></Box>
      <Box width={18}><Text color={color ? COLORS.muted : undefined}>Workers</Text></Box>
      <Box width={14}><Text color={color ? COLORS.muted : undefined}>Platform</Text></Box>
      <Box width={18}><Text color={color ? COLORS.muted : undefined}>Last seen</Text></Box>
    </Box>
  );
}

function StatusView({ state, usable, bodyBudget, color }: {
  state: HudState;
  usable: number;
  bodyBudget: number;
  color: boolean;
}): React.ReactNode {
  const visibleCount = statusDeviceCapacity(state, bodyBudget, usable);
  const devices = state.status?.devices.slice(0, visibleCount) ?? [];
  const hiddenCount = (state.status?.devices.length ?? 0) - devices.length;
  return (
    <Box height={bodyBudget} flexDirection="column" flexShrink={0} overflow="hidden">
      <Blank />
      <SectionTitle color={color}>Account</SectionTitle>
      {state.statusLoading ? (
        <>
          <Blank />
          <Text color={color ? COLORS.muted : undefined}>Loading status…</Text>
        </>
      ) : !state.status ? (
        <>
          <Blank />
          <Text color={color ? COLORS.muted : undefined}>Status is not loaded.</Text>
        </>
      ) : (
        <>
          <Text color={color ? COLORS.ink : undefined} wrap="truncate">{state.status.account}</Text>
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
          <SectionTitle color={color}>Devices</SectionTitle>
          {state.status.devices.length === 0 ? (
            <>
              <Blank />
              <Text color={color ? COLORS.muted : undefined}>No active devices.</Text>
            </>
          ) : (
            <>
              <DeviceHeading usable={usable} color={color} />
              {devices.map((device, index) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  index={index}
                  usable={usable}
                  color={color}
                />
              ))}
              {hiddenCount > 0 ? (
                <Text color={color ? COLORS.muted : undefined} wrap="truncate">
                  {`${hiddenCount} more. Use glossa devices revoke <id>.`}
                </Text>
              ) : null}
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
      <HelpRow keyLabel="D" label="Recent activity" color={color} />
      <HelpRow keyLabel="S" label="Status" color={color} />
      <HelpRow keyLabel="?" label="Close help" color={color} />
      <Blank />
      <SectionTitle color={color} tone={COLORS.coral}>Manage</SectionTitle>
      <HelpRow keyLabel="R" label="Revoke a device from status" color={color} tone={COLORS.coral} />
      <HelpRow keyLabel="L" label="Sign out" color={color} tone={COLORS.coral} />
      <Blank />
      <SectionTitle color={color}>Session</SectionTitle>
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

function Footer({ rows, usable, color }: {
  rows: HudHint[][];
  usable: number;
  color: boolean;
}): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Line usable={usable} color={color} />
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} width={usable}>
          {row.map((hint, index) => (
            <React.Fragment key={`${hint.key}-${hint.label}`}>
              {index > 0 ? <Text>   </Text> : null}
              <Text bold color={color ? (hint.tone ?? COLORS.purpleReadable) : undefined}>
                {hint.key}
              </Text>
              <Text color={color ? COLORS.muted : undefined}> {hint.label}</Text>
            </React.Fragment>
          ))}
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
      ) : state.view === "status" ? (
        <StatusView
          state={state}
          usable={metrics.usable}
          bodyBudget={metrics.bodyBudget}
          color={color}
        />
      ) : state.view === "help" ? (
        <HelpView bodyBudget={metrics.bodyBudget} color={color} />
      ) : (
        <SessionView state={state} bodyBudget={metrics.bodyBudget} color={color} />
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

async function loadStatus(
  store: HudStore,
  actions: HudUiActions,
  signal: AbortSignal,
): Promise<void> {
  const current = store.getSnapshot();
  if (current.statusLoading) return;
  if (current.connection !== "connected" && current.connection !== "retrying") {
    store.update((state) => ({
      ...state,
      notice: "Status is available after Glossa connects.",
    }));
    return;
  }
  store.update((state) => ({
    ...state,
    view: "status",
    statusLoading: true,
    prompt: undefined,
    notice: undefined,
  }));
  try {
    const status = await actions.loadStatus(signal);
    if (signal.aborted) return;
    store.update((state) => ({ ...state, status, statusLoading: false }));
  } catch (error) {
    if (signal.aborted) return;
    store.update((state) => ({
      ...state,
      statusLoading: false,
      notice: error instanceof Error ? error.message : String(error),
    }));
  }
}

function HudRuntime({ store, actions, signal, stop }: {
  store: HudStore;
  actions: HudUiActions;
  signal: AbortSignal;
  stop: (action?: HudExitAction) => void;
}): React.ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { columns, rows } = useWindowSize();
  const [, setClock] = useState(0);

  useEffect(() => {
    if (state.view !== "activity" || state.activities.length === 0) return;
    const timer = setInterval(() => setClock((value) => value + 1), ACTIVITY_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.view, state.activities.length]);

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
      if (
        current.prompt?.type === "revoke-select" ||
        current.prompt?.type === "revoke-confirm"
      ) {
        const capacity = statusDeviceCapacity(current, metrics.bodyBudget, metrics.usable);
        const selectedHidden = current.prompt.type === "revoke-confirm" &&
          current.prompt.deviceIndex >= capacity;
        if (capacity === 0 || selectedHidden) {
          next = {
            ...next,
            prompt: undefined,
            notice: "Increase the terminal height to choose a device.",
          };
        } else if (current.prompt.type === "revoke-select") {
          next = {
            ...next,
            prompt: { type: "revoke-select", deviceCount: capacity },
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
      if (current.prompt.type === "revoke-select") {
        const deviceIndex = Number(input) - 1;
        if (
          Number.isInteger(deviceIndex) &&
          deviceIndex >= 0 &&
          deviceIndex < current.prompt.deviceCount
        ) {
          store.update((state) => ({
            ...state,
            prompt: { type: "revoke-confirm", deviceIndex },
          }));
        }
        return;
      }
      if (value !== "y") return;
      if (current.prompt.type === "logout") {
        stop("logout");
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
        await loadStatus(store, actions, signal);
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

    if (key.escape) {
      store.update((state) => ({ ...state, view: "session", notice: undefined }));
      return;
    }
    if (value === "d") {
      const entering = current.view !== "activity";
      store.update((state) => ({
        ...state,
        view: entering ? "activity" : "session",
        activityPage: entering ? 0 : state.activityPage,
        notice: undefined,
      }));
      return;
    }
    if (value === "s") {
      void loadStatus(store, actions, signal);
      return;
    }
    if (value === "r" && current.view === "status") {
      const count = current.status?.devices.length ?? 0;
      if (count === 0) {
        store.update((state) => ({ ...state, notice: "There are no devices to revoke." }));
        return;
      }
      const metrics = screenMetrics(current, columns, rows);
      const capacity = statusDeviceCapacity(current, metrics.bodyBudget, metrics.usable);
      store.update((state) => capacity === 0
        ? { ...state, notice: "Increase the terminal height to choose a device." }
        : {
            ...state,
            prompt: { type: "revoke-select", deviceCount: capacity },
            notice: undefined,
          });
      return;
    }
    if (value === "l") {
      store.update((state) => ({
        ...state,
        prompt: { type: "logout" },
        notice: undefined,
      }));
      return;
    }
    if (input === "?") {
      store.update((state) => ({
        ...state,
        view: state.view === "help" ? "session" : "help",
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
): Promise<HudExitAction> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Glossa requires an interactive terminal.");
  }

  const controller = new AbortController();
  const store = new HudStore(actions.workspace);
  let exitAction: HudExitAction = "quit";
  let instance: ReturnType<typeof render> | undefined;

  const stop = (action: HudExitAction = "quit"): void => {
    exitAction = action;
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
    return exitAction;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stopFromSignal);
    process.removeListener("SIGTERM", stopFromSignal);
  }
}
