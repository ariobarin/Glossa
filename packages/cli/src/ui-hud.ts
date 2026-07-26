import { emitKeypressEvents, type Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  statusMessage,
  type ManagedSessionEvent,
} from "./worker/managed-session.js";

export interface HudActivity {
  label: string;
  requestId: string;
  ok?: boolean;
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
  | { type: "update" }
  | { type: "revoke-select" }
  | { type: "revoke-confirm"; deviceIndex: number };

export type HudExitAction = "quit" | "logout" | "update";

export interface HudState {
  workspace: string;
  deviceName?: string;
  connection: "starting" | "connecting" | "connected" | "retrying" | "disconnected" | "error";
  connectedBefore: boolean;
  message: string | undefined;
  activities: HudActivity[];
  view: HudView;
  status: HudStatus | undefined;
  statusLoading: boolean;
  prompt: HudPrompt | undefined;
  busy: boolean;
  notice: string | undefined;
}

export interface HudUiActions {
  workspace: string;
  run(signal: AbortSignal, onEvent: (event: ManagedSessionEvent) => void): Promise<void>;
  peekStatus?(): HudStatus | undefined;
  subscribeStatus?(listener: (status: HudStatus) => void): () => void;
  loadStatus(signal: AbortSignal): Promise<HudStatus>;
  revokeDevice(deviceId: string, signal: AbortSignal): Promise<void>;
}

export function initialHudState(workspace: string): HudState {
  return {
    workspace,
    connection: "starting",
    connectedBefore: false,
    message: undefined,
    activities: [],
    view: "session",
    status: undefined,
    statusLoading: false,
    prompt: undefined,
    busy: false,
    notice: undefined,
  };
}

function activityLabel(event: Extract<ManagedSessionEvent, { type: "activity" }>): string {
  const noun =
    event.jobType === "write_file"
      ? "File write"
      : event.jobType === "edit_file"
        ? "File edit"
        : event.jobType === "run_command"
          ? "Command"
          : "Cancellation";
  if (event.phase === "requested") return `${noun} requested`;
  if (event.jobType === "run_command") return `Command ${event.ok ? "started" : "rejected"}`;
  return `${noun} ${event.ok ? "completed" : "rejected"}`;
}

export function applyHudEvent(state: HudState, event: ManagedSessionEvent): HudState {
  if (event.type === "session") {
    return { ...state, workspace: event.root, deviceName: event.deviceName };
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
      connectedBefore: state.connectedBefore || event.status.state === "connected",
      message: undefined,
    };
  }
  if (event.type === "notice") return { ...state, message: event.message };
  const activity: HudActivity = event.phase === "finished"
    ? { label: activityLabel(event), requestId: event.requestId, ok: event.ok }
    : { label: activityLabel(event), requestId: event.requestId };
  return { ...state, activities: [...state.activities.slice(-7), activity] };
}

const ANSI_BASE = "\u001b[22;38;2;244;241;251;48;2;17;16;22m";
const PALETTE = {
  ink: "38;2;244;241;251",
  muted: "38;2;170;164;181",
  purple: "38;2;128;84;255",
  purpleReadable: "38;2;173;152;255",
  coral: "38;2;255;102;95",
  line: "38;2;92;85;110",
} as const;

function style(enabled: boolean, code: string, value: string): string {
  return enabled ? `\u001b[${code}m${value}${ANSI_BASE}` : value;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function wrapText(value: string, width: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function sectionTitle(
  label: string,
  color: boolean,
  tone: string = PALETTE.purpleReadable,
): string {
  return style(color, `${tone};1`, label.toUpperCase());
}

function renderHeader(view: HudView, usable: number, color: boolean): string[] {
  const brand = "Glossa";
  const fullViewLabel = {
    session: "SESSION",
    activity: "ACTIVITY",
    status: "ACCOUNT & DEVICES",
    help: "KEYBOARD",
  }[view];
  const viewLabel = truncate(
    fullViewLabel,
    Math.max(4, usable - brand.length - 1),
  );
  const gap = " ".repeat(Math.max(1, usable - brand.length - viewLabel.length));
  return [
    `${style(color, `${PALETTE.purple};1`, brand)}${gap}${style(color, `${PALETTE.coral};1`, viewLabel)}`,
    style(color, PALETTE.line, "─".repeat(usable)),
  ];
}

function connectionCopy(state: HudState): { glyph: string; label: string; detail: string } {
  if (state.connection === "connected") {
    return {
      glyph: "●",
      label: "Connected",
      detail: state.message ?? "ChatGPT can use this workspace.",
    };
  }
  if (state.connection === "connecting" || state.connection === "starting") {
    return { glyph: "◌", label: "Connecting", detail: "Establishing the managed relay session…" };
  }
  if (state.connection === "retrying") {
    return { glyph: "◌", label: "Reconnecting", detail: state.message ?? "Retrying automatically…" };
  }
  if (state.connection === "error") {
    return { glyph: "×", label: "Error", detail: state.message ?? "The session stopped unexpectedly." };
  }
  return { glyph: "○", label: "Disconnected", detail: "The workspace is no longer exposed." };
}

function renderSession(state: HudState, usable: number, color: boolean): string[] {
  const copy = connectionCopy(state);
  const statusTone =
    state.connection === "connected"
      ? PALETTE.purpleReadable
      : state.connection === "error"
        ? PALETTE.coral
        : PALETTE.muted;
  const lines = [
    "",
    style(color, `${statusTone};1`, `${copy.glyph} ${copy.label}`),
    ...wrapText(copy.detail, usable).map((line) => style(color, PALETTE.muted, line)),
    "",
    sectionTitle("Workspace", color),
    style(color, PALETTE.ink, truncate(state.workspace, usable)),
  ];
  if (state.deviceName) {
    lines.push(
      style(color, PALETTE.muted, `Device  ${truncate(state.deviceName, Math.max(8, usable - 8))}`),
    );
  }
  lines.push(
    "",
    ...wrapText(
      "Files and commands use your account permissions.",
      Math.max(8, usable - 2),
    ).map((line, index) =>
      `${index === 0 ? style(color, `${PALETTE.coral};1`, "!") : " "} ${style(color, PALETTE.muted, line)}`
    ),
  );
  const latest = state.activities.at(-1);
  lines.push(
    "",
    sectionTitle("Latest activity", color),
    latest
      ? `${style(color, latest.ok === false ? PALETTE.coral : PALETTE.purpleReadable, latest.ok === false ? "×" : "•")} ${style(color, PALETTE.ink, truncate(latest.label, Math.max(8, usable - 2)))}`
      : style(color, PALETTE.muted, "No tool activity yet."),
  );
  return lines;
}

function renderActivity(state: HudState, usable: number, color: boolean): string[] {
  const lines = ["", sectionTitle("Recent activity", color)];
  if (state.activities.length === 0) {
    lines.push("", style(color, PALETTE.muted, "No tool activity yet."));
  }
  for (const activity of state.activities.slice(-8)) {
    const outcome =
      activity.ok === false
        ? style(color, PALETTE.coral, "×")
        : style(color, activity.ok === true ? PALETTE.purpleReadable : PALETTE.muted, "•");
    lines.push(
      "",
      `${outcome} ${style(color, PALETTE.ink, truncate(activity.label, Math.max(8, usable - 2)))}`,
      `  ${style(color, PALETTE.muted, `Request ${activity.requestId.slice(0, 8)}`)}`,
    );
  }
  return lines;
}

function renderStatus(state: HudState, usable: number, color: boolean): string[] {
  const lines = ["", sectionTitle("Account", color)];
  if (state.statusLoading) {
    lines.push("", style(color, PALETTE.muted, "Loading account and devices…"));
    return lines;
  }
  if (!state.status) {
    lines.push("", style(color, PALETTE.muted, "Status is not loaded."));
    return lines;
  }
  lines.push(
    style(color, PALETTE.ink, truncate(state.status.account, usable)),
    style(color, PALETTE.muted, truncate(state.status.relay, usable)),
    "",
    sectionTitle("Active workspaces", color, PALETTE.coral),
    style(
      color,
      PALETTE.ink,
      state.status.activeWorkers === null
        ? "Unavailable"
        : String(state.status.activeWorkers),
    ),
    "",
    sectionTitle(`Devices  ${state.status.devices.length}`, color),
  );
  if (state.status.devices.length === 0) {
    lines.push("", style(color, PALETTE.muted, "No devices enrolled."));
  }
  state.status.devices.slice(0, 9).forEach((device, index) => {
    const statusTone =
      device.status.includes("active")
        ? PALETTE.purpleReadable
        : device.status === "revoked"
          ? PALETTE.coral
          : PALETTE.muted;
    lines.push(
      "",
      `${style(color, `${PALETTE.coral};1`, String(index + 1).padStart(2))}  ${style(color, `${PALETTE.ink};1`, truncate(device.name, Math.max(8, usable - 4)))}`,
      `    ${style(color, statusTone, device.status)}`,
      `    ${style(color, PALETTE.muted, truncate(`${device.platform}  •  seen ${device.lastSeen}`, Math.max(8, usable - 4)))}`,
    );
  });
  return lines;
}

function helpRows(
  key: string,
  label: string,
  usable: number,
  color: boolean,
  tone: string = PALETTE.purpleReadable,
): string[] {
  const indent = " ".repeat(key.length + 2);
  return wrapText(label, Math.max(8, usable - indent.length)).map((line, index) =>
    index === 0
      ? `${style(color, `${tone};1`, key)}  ${line}`
      : `${indent}${line}`
  );
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
    ...helpRows("R", "Revoke a device from the status view", usable, color, PALETTE.coral),
    ...helpRows("L", "Sign out", usable, color, PALETTE.coral),
    ...helpRows("U", "Update Glossa", usable, color, PALETTE.coral),
    "",
    sectionTitle("Session", color),
    ...helpRows("Q", "Disconnect and quit", usable, color, PALETTE.coral),
    ...helpRows("Ctrl+C", "Disconnect and quit", usable, color, PALETTE.coral),
  ];
}

function promptText(state: HudState): { message: string; choices?: string } | undefined {
  if (state.busy) return { message: "Working…" };
  if (!state.prompt) return undefined;
  if (state.prompt.type === "logout") {
    return { message: "Sign out and disconnect?", choices: "Y confirm  N cancel" };
  }
  if (state.prompt.type === "update") {
    return { message: "Disconnect and update Glossa?", choices: "Y confirm  N cancel" };
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
      { key: "U", label: "Update", tone: PALETTE.coral },
      { key: "Esc", label: "Session" },
      { key: "Q", label: "Disconnect", tone: PALETTE.coral },
    ];
  }
  if (state.view === "activity") {
    return [
      { key: "D", label: "Session" },
      { key: "S", label: "Status" },
      { key: "?", label: "Help" },
      { key: "Q", label: "Disconnect", tone: PALETTE.coral },
    ];
  }
  if (state.view === "help") {
    return [
      { key: "?", label: "Session" },
      { key: "Q", label: "Disconnect", tone: PALETTE.coral },
    ];
  }
  return [
    { key: "D", label: "Activity" },
    { key: "S", label: "Status" },
    { key: "?", label: "Help" },
    { key: "Q", label: "Disconnect", tone: PALETTE.coral },
  ];
}

function renderFooter(state: HudState, usable: number, color: boolean): string[] {
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

export function renderHud(
  state: HudState,
  width = 80,
  color = !process.env.NO_COLOR,
): string {
  const usable = Math.max(20, width - 4);
  const margin = width >= 24 ? "  " : "";
  const lines = [...renderHeader(state.view, usable, color)];
  if (state.view === "activity") lines.push(...renderActivity(state, usable, color));
  else if (state.view === "status") lines.push(...renderStatus(state, usable, color));
  else if (state.view === "help") lines.push(...renderHelp(usable, color));
  else lines.push(...renderSession(state, usable, color));

  if (state.notice) {
    lines.push(
      "",
      style(color, PALETTE.line, "─".repeat(usable)),
      ...wrapText(`! ${state.notice}`, usable).map((line) => style(color, PALETTE.coral, line)),
    );
  }
  const prompt = promptText(state);
  if (prompt) {
    lines.push(
      "",
      style(color, PALETTE.line, "─".repeat(usable)),
      style(color, `${PALETTE.coral};1`, truncate(prompt.message, usable)),
    );
    if (prompt.choices) lines.push(style(color, PALETTE.muted, prompt.choices));
  }
  lines.push(
    "",
    style(color, PALETTE.line, "─".repeat(usable)),
    ...renderFooter(state, usable, color),
  );
  return lines.map((line) => line ? `${margin}${line}` : "").join("\n");
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
  const color = !process.env.NO_COLOR;

  const render = (): void => {
    const view = renderHud(state, output.columns ?? 80, color);
    output.write(`${color ? ANSI_BASE : ""}\u001b[H\u001b[2J${view}`);
  };

  const loadStatus = async (): Promise<void> => {
    if (state.connection !== "connected" && state.connection !== "retrying") {
      state = { ...state, notice: "Status is available after Glossa connects." };
      render();
      return;
    }
    const cached = state.status ?? actions.peekStatus?.();
    state = {
      ...state,
      view: "status",
      status: cached,
      statusLoading: !cached,
      prompt: undefined,
      notice: undefined,
    };
    render();
    try {
      const refreshed = await actions.loadStatus(controller.signal);
      if (controller.signal.aborted) return;
      const status = actions.peekStatus?.() ?? refreshed;
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

  const unsubscribeStatus = actions.subscribeStatus?.((status) => {
    state = { ...state, status, statusLoading: false };
    if (state.view === "status") render();
  }) ?? (() => undefined);

  const session = actions.run(controller.signal, (event) => {
    state = applyHudEvent(state, event);
    render();
  }).then(() => {
    if (!controller.signal.aborted) state = { ...state, connection: "disconnected" };
    render();
  }).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    state = {
      ...state,
      connection: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    render();
    throw error;
  });

  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?1049h\u001b[?25l");
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
      stopUi = resolve;
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
              deviceIndex < (state.status?.devices.length ?? 0)
            ) {
              state = { ...state, prompt: { type: "revoke-confirm", deviceIndex } };
              render();
            }
            return;
          }
          if (key.name !== "y") return;
          if (state.prompt.type === "logout") return stop("logout");
          if (state.prompt.type === "update") return stop("update");
          const device = state.status?.devices[state.prompt.deviceIndex];
          if (!device) return;
          state = { ...state, busy: true, prompt: undefined, notice: undefined };
          render();
          void actions.revokeDevice(device.id, controller.signal).then(async () => {
            if (controller.signal.aborted) return;
            state = { ...state, busy: false, notice: `Revoked ${device.name}.` };
            render();
            await loadStatus();
          }).catch((error: unknown) => {
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

        if (key.name === "escape") {
          state = { ...state, view: "session", notice: undefined };
          render();
        } else if (key.name === "d") {
          state = {
            ...state,
            view: state.view === "activity" ? "session" : "activity",
            notice: undefined,
          };
          render();
        } else if (key.name === "s") {
          void loadStatus();
        } else if (key.name === "r" && state.view === "status") {
          if ((state.status?.devices.length ?? 0) === 0) {
            state = { ...state, notice: "There are no devices to revoke." };
          } else {
            state = { ...state, prompt: { type: "revoke-select" }, notice: undefined };
          }
          render();
        } else if (key.name === "l") {
          state = { ...state, prompt: { type: "logout" }, notice: undefined };
          render();
        } else if (key.name === "u") {
          state = { ...state, prompt: { type: "update" }, notice: undefined };
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
    unsubscribeStatus();
    process.removeListener("SIGINT", stopFromSignal);
    process.removeListener("SIGTERM", stopFromSignal);
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\u001b[0m\u001b[?25h\u001b[?1049l");
  }
}
