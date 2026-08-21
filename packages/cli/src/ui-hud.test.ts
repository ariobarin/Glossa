import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { applyHudEvent, initialHudState, type HudState } from "./ui-hud-model.js";
import { renderHud, runSessionHud } from "./ui-hud.js";

function connectedState(): HudState {
  return {
    ...initialHudState("C:\\code\\glossa"),
    deviceName: "Desk",
    connection: "connected",
    connectedBefore: true,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for HUD state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("HUD keeps the connection header stable", () => {
  const running = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-1",
      argv: ["npm", "run", "check"],
      timeoutMs: 30_000,
    },
  });
  const output = renderHud(running, 80, false, 20);
  assert.match(output.split("\n")[0] ?? "", /Connected$/);
  assert.doesNotMatch(output.split("\n")[0] ?? "", /run_command/);
});

test("HUD breadcrumbs identify every top-level view", () => {
  const activity = renderHud({ ...connectedState(), view: "activity" }, 80, false, 20);
  const workspace = renderHud({ ...connectedState(), view: "workspace" }, 80, false, 20);
  const devices = renderHud({ ...connectedState(), view: "devices" }, 80, false, 20);
  const help = renderHud({ ...connectedState(), view: "help" }, 80, false, 20);

  assert.match(activity.split("\n")[0] ?? "", /Glossa \/ Activity\s+Connected/);
  assert.match(workspace.split("\n")[0] ?? "", /Glossa \/ Workspace\s+Connected/);
  assert.match(devices.split("\n")[0] ?? "", /Glossa \/ Devices\s+Connected/);
  assert.match(help.split("\n")[0] ?? "", /Glossa \/ Help\s+Connected/);
});

test("keeps cached device rows visible during background refresh", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "devices",
      statusLoading: true,
      status: {
        relay: "https://relay.example",
        activeWorkers: 1,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeenAt: "2026-08-17T21:00:00.000Z",
          status: "active",
        }],
      },
    },
    110,
    false,
    24,
  );

  assert.match(output, /Laptop/);
  assert.match(output, /win32-x64/);
});

test("footer keeps navigation left and contextual controls right", () => {
  const width = 110;
  const activity = renderHud(
    { ...connectedState(), view: "activity" },
    width,
    false,
    20,
  ).split("\n").at(-1)!;
  const workspace = renderHud(
    { ...connectedState(), view: "workspace", accessProfile: "workspace" },
    width,
    false,
    20,
  ).split("\n").at(-1)!;
  const devices = renderHud(
    {
      ...connectedState(),
      view: "devices",
      status: {
        relay: "https://relay.example",
        activeWorkers: 0,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeenAt: null,
          status: "offline",
        }],
      },
    },
    width,
    false,
    20,
  ).split("\n").at(-1)!;
  const help = renderHud(
    { ...connectedState(), view: "help" },
    width,
    false,
    20,
  ).split("\n").at(-1)!;

  const regularNav = /A Activity\s+W Workspace\s+D Devices\s+\? Help\s+Q Quit/;
  for (const footer of [activity, workspace, devices, help]) {
    assert.match(footer, regularNav);
  }
  assert.match(activity, /↑ Older\s+↓ Newer$/);
  assert.match(workspace, /← Read only\s+→ System$/);
  assert.match(devices, /↑↓ Select\s+Enter\/R Revoke$/);
});

test("workspace access handoff has no visible intermediate frame", () => {
  const pending = renderHud(
    {
      ...connectedState(),
      view: "workspace",
      accessProfile: "workspace",
      pendingAccessProfile: "system",
    },
    110,
    false,
    20,
  );
  const confirmed = renderHud(
    {
      ...connectedState(),
      view: "workspace",
      accessProfile: "system",
      pendingAccessProfile: undefined,
    },
    110,
    false,
    20,
  );

  assert.equal(pending, confirmed);
  assert.match(pending, /ACCESS\s+← Switch\s+System\s+Read \+ write files \+ commands\s+OS account permissions apply/);
  assert.doesNotMatch(pending, /Restarting|Connecting|Reconnecting/);
});

test("activity layout aligns tool arguments and timestamps", () => {
  const now = Date.now();
  const state: HudState = {
    ...connectedState(),
    view: "activity",
    activities: [
      {
        tool: "read_file",
        summary: { target: 'path "one.ts"', details: [], truncation: "middle" },
        requestId: "one",
        state: "returned",
        updatedAt: now - 15_000,
      },
      {
        tool: "search_text",
        summary: { target: 'query "needle"', details: [], truncation: "middle" },
        requestId: "two",
        state: "failed",
        updatedAt: now - 75_000,
      },
      {
        tool: "run_command",
        summary: { target: 'argv ["npm"]', details: [], truncation: "middle" },
        requestId: "three",
        state: "working",
        updatedAt: now,
      },
    ],
  };
  const output = renderHud(state, 100, false, 20, now);
  const rows = output.split("\n").filter((line) =>
    line.includes("one.ts") || line.includes("needle") || line.includes('argv ["npm"]')
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.indexOf("path"), rows[1]!.indexOf("query"));
  assert.equal(rows[1]!.indexOf("query"), rows[2]!.indexOf("argv"));
  assert.match(rows[0]!, /15s ago$/);
  assert.match(rows[1]!, /1m ago$/);
  assert.match(rows[2]!, /now$/);
  assert.match(rows[0]!, /✓\s+read_file/);
  assert.match(rows[1]!, /×\s+search_text/);
  assert.match(rows[2]!, /○\s+run_command/);
});

test("activity view paginates newest-first without an agent block", () => {
  const activities = Array.from({ length: 30 }, (_, index) => ({
    tool: "read_file" as const,
    summary: {
      target: `path "file-${index + 1}.txt"`,
      details: [],
      truncation: "middle" as const,
    },
    requestId: `request-${index + 1}`,
    state: "returned" as const,
    updatedAt: Date.now(),
  }));
  const output = renderHud(
    { ...connectedState(), view: "activity", activities },
    80,
    false,
    20,
  );
  assert.match(output.split("\n")[0] ?? "", /Glossa \/ Activity \(1-15\/30\)/);
  assert.doesNotMatch(output, /AGENT|last activity/);
  assert.match(output, /file-30\.txt/);
  assert.doesNotMatch(output, /file-1\.txt/);
});

test("devices keyboard navigation revokes the selected device", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
    ref(): unknown;
    unref(): unknown;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  input.ref = () => input;
  input.unref = () => input;

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 24;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });

  const devices = [1, 2, 3].map((index) => ({
    id: `device-${index}`,
    name: `Device ${index}`,
    platform: "win32-x64",
    lastSeenAt: null,
    status: "offline",
  }));
  const revoked: string[] = [];
  const run = runSessionHud(
    {
      workspace: "C:\\code\\glossa",
      run: async (signal, onEvent) => {
        onEvent({
          type: "status",
          status: {
            state: "connected",
            reconnected: false,
          },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      loadStatus: async () => ({
        relay: "https://relay.example",
        activeWorkers: 0,
        devices,
      }),
      revokeDevice: async (deviceId) => {
        revoked.push(deviceId);
      },
      changeAccessProfile: () => undefined,
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await waitFor(() => rendered.includes("Glossa / Workspace"));
  input.write("d");
  await waitFor(() => rendered.includes("Glossa / Devices"));
  input.write("\u001b[B");
  await waitFor(() => rendered.includes("› Device 2"));
  input.write("\r");
  await waitFor(() => rendered.includes("Revoke Device 2?"));
  input.write("y");
  await waitFor(() => revoked.length === 1);
  assert.deepEqual(revoked, ["device-2"]);

  input.write("q");
  await run;
});

test("workspace access controls deescalate directly and confirm escalation", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
    ref(): unknown;
    unref(): unknown;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  input.ref = () => input;
  input.unref = () => input;

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 110;
  output.rows = 24;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });

  let reportSession: ((profile: "read-only" | "workspace" | "system") => void) | undefined;
  const changes: string[] = [];
  const run = runSessionHud(
    {
      workspace: "C:\\code\\glossa",
      run: async (signal, onEvent) => {
        reportSession = (accessProfile) => {
          onEvent({
            type: "session",
            root: "C:\\code\\glossa",
            deviceName: "Desk",
            accessProfile,
          });
          onEvent({
            type: "status",
            status: {
              state: "connected",
              reconnected: accessProfile !== "workspace",
            },
          });
        };
        reportSession("workspace");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      loadStatus: async () => {
        throw new Error("not used");
      },
      revokeDevice: async () => {
        throw new Error("not used");
      },
      changeAccessProfile: (accessProfile) => {
        changes.push(accessProfile);
        setTimeout(() => reportSession?.(accessProfile), 0);
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await waitFor(() => rendered.includes("Glossa / Workspace"));
  input.write("\u001b[C");
  await waitFor(() => rendered.includes("Increase access to System?"));
  assert.match(rendered, /Increase access to System\? Commands will inherit this OS account's permissions\./);
  input.write("y");
  await waitFor(() => changes.length === 1);
  assert.deepEqual(changes, ["system"]);

  await waitFor(() => rendered.includes("OS account permissions apply"));
  input.write("\u001b[D");
  await waitFor(() => changes.length === 2);
  assert.deepEqual(changes, ["system", "workspace"]);
  await waitFor(() => rendered.includes("Commands disabled"));
  input.write("\u001b[D");
  await waitFor(() => changes.length === 3);
  assert.deepEqual(changes, ["system", "workspace", "read-only"]);

  input.write("q");
  await run;
});

test("runtime owns the TTY lifecycle and survives resize", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
    ref(): unknown;
    unref(): unknown;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  input.ref = () => input;
  input.unref = () => input;

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 70;
  output.rows = 18;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });

  const run = runSessionHud(
    {
      workspace: "C:\\code\\glossa",
      workspaceLabel: "ink-test",
      run: async (signal, onEvent) => {
        onEvent({
          type: "status",
          status: {
            state: "connected",
            reconnected: false,
          },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      loadStatus: async () => {
        throw new Error("not used");
      },
      revokeDevice: async () => {
        throw new Error("not used");
      },
      changeAccessProfile: () => undefined,
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  output.rows = 10;
  output.emit("resize");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  input.write("q");

  await run;
  assert.equal(input.isRaw, false);
  assert.ok(rendered.includes("\u001b]0;Glossa | ink-test\u0007"));
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
});
