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

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
  label = "HUD state",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
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

  assert.match(activity.split("\n")[0] ?? "", /Glossa \/ Activity\s+Connected/);
  assert.match(workspace.split("\n")[0] ?? "", /Glossa \/ Workspace\s+Connected/);
  assert.match(devices.split("\n")[0] ?? "", /Glossa \/ Devices\s+Connected/);
});

test("footer keeps navigation left and only available controls right", () => {
  const width = 110;
  const activityState = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: { type: "read_file", requestId: "request-1", path: "README.md" },
  });
  const activity = renderHud(
    { ...activityState, view: "activity" },
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
          lastSeen: "just now",
          status: "offline",
        }],
      },
    },
    width,
    false,
    20,
  ).split("\n").at(-1)!;

  const regularNav = /A Activity\s+W Workspace\s+D Devices\s+Q Quit/;
  for (const footer of [activity, workspace, devices]) {
    assert.match(footer, regularNav);
  }
  assert.match(activity, /Tab Detailed\s+Enter Select$/);
  assert.doesNotMatch(activity, /Older|Newer/);
  assert.match(workspace, /← Read only\s+→ System$/);
  assert.match(devices, /↑↓ Select\s+Enter Revoke$/);
});

test("empty Activity does not advertise actions that cannot do anything", () => {
  const output = renderHud(
    { ...connectedState(), view: "activity", activities: [] },
    90,
    false,
    20,
  );
  const footer = output.split("\n").at(-1)!;
  assert.match(output, /No activity yet\./);
  assert.match(footer, /A Activity\s+W Workspace\s+D Devices\s+Q Quit/);
  assert.doesNotMatch(footer, /Tab|Older|Newer|Select|Inspect/);
});

test("access confirmation owns input and keeps the full security boundary visible", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "workspace",
      accessProfile: "workspace",
      prompt: { type: "access-confirm", accessProfile: "system" },
    },
    60,
    false,
    18,
  );
  assert.match(output, /Increase access to System\?/);
  assert.match(output, /permissions, environment,\s+credentials, and network\./);
  assert.match(output, /Y Confirm\s+N Cancel/);
  assert.doesNotMatch(output, /A Activity|W Workspace|D Devices|← Read only|→ System|…/);
});

test("busy state names the active operation and hides irrelevant controls", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "devices",
      busy: true,
      busyMessage: "Revoking Build box…",
      status: {
        relay: "https://relay.example",
        activeWorkers: 0,
        devices: [{
          id: "device-1",
          name: "Build box",
          platform: "linux-x64",
          lastSeen: "2m ago",
          status: "offline",
        }],
      },
    },
    80,
    false,
    20,
  );
  assert.match(output, /Revoking Build box…/);
  assert.doesNotMatch(output, /Working…|↑↓ Select|Enter Revoke|A Activity|W Workspace|D Devices/);
  assert.match(output.split("\n").at(-1)!, /Q Quit/);
});

test("Activity inspect only advertises hidden content when it actually overflows", () => {
  const job = {
    type: "run_command" as const,
    requestId: "request-overflow",
    argv: ["npm", "run", "check", "--workspace", "@ariobarin/glossa", "--", "--reporter", "spec"],
    stdin: "input",
    timeoutMs: 120_000,
    waitMs: 0,
  };
  const state = applyHudEvent(connectedState(), { type: "activity", phase: "started", job });
  const inspect = {
    ...state,
    view: "activity-detail" as const,
    activitySelection: job.requestId,
  };
  const tall = renderHud(inspect, 80, false, 28);
  const short = renderHud(inspect, 80, false, 10);
  assert.doesNotMatch(tall.split("\n").at(-1)!, /more/);
  assert.match(short.split("\n").at(-1)!, /↓ \d+ more\s+Esc Back/);
});

test("activity footer keeps stable controls pinned across density toggles", () => {
  const position = (output: string, value: string): [number, number] => {
    const lines = output.split("\n");
    const row = lines.findIndex((line) => line.includes(value));
    assert.notEqual(row, -1, `Missing ${value}`);
    return [row, lines[row]!.indexOf(value)];
  };
  const activities = Array.from({ length: 30 }, (_, index) => ({
    tool: "read_file" as const,
    summary: { target: `path "file-${index + 1}.ts"`, details: [], truncation: "middle" as const },
    requestId: `request-${index + 1}`,
    state: "returned" as const,
    updatedAt: Date.now(),
  }));
  const base = {
    ...connectedState(),
    view: "activity" as const,
    activities,
    activityBrowseAnchor: "request-20",
  };

  for (const width of [54, 60, 70, 80, 90, 110]) {
    const compact = renderHud({ ...base, activityMode: "compact" }, width, false, 20);
    const detailed = renderHud({ ...base, activityMode: "detailed" }, width, false, 20);
    for (const control of ["↑ Older", "↓ Newer", "Enter Select"]) {
      assert.deepEqual(
        position(compact, control),
        position(detailed, control),
        `${control} shifted at ${width} columns`,
      );
    }

    const compactSelected = renderHud(
      { ...base, activityMode: "compact", activitySelection: "request-15" },
      width,
      false,
      20,
    );
    const detailedSelected = renderHud(
      { ...base, activityMode: "detailed", activitySelection: "request-15" },
      width,
      false,
      20,
    );
    for (const control of ["↑↓ Select", "Enter Inspect", "Esc Browse"]) {
      assert.deepEqual(
        position(compactSelected, control),
        position(detailedSelected, control),
        `${control} shifted in selection mode at ${width} columns`,
      );
    }
  }
});

test("activating Activity selection does not shift row columns", () => {
  const now = Date.now();
  const activities = [
    {
      tool: "read_file" as const,
      summary: { target: 'path "one.ts"', details: [], truncation: "middle" as const },
      requestId: "one",
      state: "returned" as const,
      updatedAt: now - 15_000,
    },
    {
      tool: "read_file" as const,
      summary: { target: 'path "two.ts"', details: [], truncation: "middle" as const },
      requestId: "two",
      state: "returned" as const,
      updatedAt: now - 10_000,
    },
    {
      tool: "read_file" as const,
      summary: { target: 'path "three.ts"', details: [], truncation: "middle" as const },
      requestId: "three",
      state: "returned" as const,
      updatedAt: now - 5_000,
    },
  ];
  const browse = renderHud(
    { ...connectedState(), view: "activity", activities },
    90,
    false,
    20,
    now,
  );
  const selected = renderHud(
    { ...connectedState(), view: "activity", activities, activitySelection: "two" },
    90,
    false,
    20,
    now,
  );
  const browseRow = browse.split("\n").find((line) => line.includes('path "two.ts"'))!;
  const selectedRow = selected.split("\n").find((line) => line.includes('path "two.ts"'))!;

  for (const token of ["✓", "read_file", 'path "two.ts"', "10s ago"]) {
    assert.equal(
      browseRow.indexOf(token),
      selectedRow.indexOf(token),
      `${token} shifted when selection activated`,
    );
  }
  assert.match(selectedRow, /›\s+✓/);
});

test("workspace access controls only advertise available changes", () => {
  const footer = (
    accessProfile: "read-only" | "workspace" | "system",
    overrides: Partial<HudState> = {},
  ): string => renderHud(
    { ...connectedState(), view: "workspace", accessProfile, ...overrides },
    110,
    false,
    20,
  ).split("\n").at(-1)!;

  assert.match(footer("read-only"), /→ Workspace$/);
  assert.doesNotMatch(footer("read-only"), /←/);
  assert.match(footer("workspace"), /← Read only\s+→ System$/);
  assert.match(footer("system"), /← Workspace$/);
  assert.doesNotMatch(
    footer("workspace", { pendingAccessProfile: "system", connection: "connecting" }),
    /← Read only|→ System/,
  );
  assert.doesNotMatch(footer("workspace", { connection: "retrying" }), /← Read only|→ System/);
});

test("workspace access handoff stays truthful until the replacement connects", () => {
  const pending = renderHud(
    {
      ...connectedState(),
      view: "workspace",
      connection: "connecting",
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

  assert.match(pending.split("\n")[0] ?? "", /Connecting$/);
  assert.match(pending, /Access\s+Workspace · read \+ write files/);
  assert.match(pending, /Switching to System…/);
  assert.doesNotMatch(pending, /Access\s+System/);
  assert.match(confirmed, /Access\s+System · read \+ write files \+ commands/);
  assert.doesNotMatch(confirmed, /Switching/);
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

test("activity view follows newest activity without an agent block", () => {
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
  assert.match(output.split("\n")[0] ?? "", /Glossa \/ Activity \(17-30\/30\)/);
  assert.doesNotMatch(output, /AGENT|last activity/);
  assert.match(output, /✓\s+read_file\s+path "file-30\.txt"/);
  assert.doesNotMatch(output, /›/);
  assert.doesNotMatch(output, /file-1\.txt/);
});

test("activity keyboard toggles density and inspects the selected call", async () => {
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
  output.rows = 28;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });

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
        onEvent({
          type: "activity",
          phase: "returned",
          job: {
            type: "read_file",
            requestId: "00000000-0000-4000-8000-000000000021",
            path: "packages/cli/src/ui-hud.tsx",
          },
          ok: true,
        });
        onEvent({
          type: "activity",
          phase: "started",
          job: {
            type: "run_command",
            requestId: "00000000-0000-4000-8000-000000000022",
            argv: ["npm", "run", "check", "--workspace", "@ariobarin/glossa"],
            timeoutMs: 120_000,
          },
        });
        onEvent({
          type: "activity",
          phase: "returned",
          job: {
            type: "view_image",
            requestId: "00000000-0000-4000-8000-000000000023",
            path: ".hud-preview/current.png",
          },
          ok: true,
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

  try {
    await waitFor(() => rendered.includes("Glossa / Workspace"), 1_000, "Workspace view");
    input.write("a");
    await waitFor(() => rendered.includes("Enter Select"), 1_000, "browse Activity view");
    assert.match(rendered, /npm run check/);

    input.write("\t");
    await waitFor(() => rendered.includes("Tab Compact"), 1_000, "detailed browse view");
    assert.match(rendered, /argv \["npm"/);

    input.write("\r");
    await waitFor(() => rendered.includes("Enter Inspect"), 1_000, "selection Activity view");
    assert.match(rendered, /›\s+○\s+run_command/);
    assert.match(rendered, /Esc Browse/);

    input.write("\r");
    await waitFor(() => rendered.includes("Activity / Run Command"), 1_000, "Activity inspect view");
    assert.match(rendered, /@ariobarin\/glossa/);
    assert.match(rendered, /Esc Back/);
    assert.doesNotMatch(rendered, /↑↓ Scroll|← Older|→ Newer/);

    const beforeBack = rendered.length;
    input.write("\r");
    await waitFor(
      () => rendered.slice(beforeBack).includes("Enter Inspect"),
      1_000,
      "selection view after Enter back",
    );
  } finally {
    input.write("q");
    await run;
  }
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
    lastSeen: "just now",
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
  const beforePrompt = rendered.length;
  input.write("\u001b[C");
  await waitFor(() => rendered.slice(beforePrompt).includes("Increase access to System?"));
  const promptFrame = rendered.slice(beforePrompt);
  assert.match(promptFrame, /Increase access to System\?/);
  assert.match(promptFrame, /permissions, environment, credentials, and network\./);
  assert.match(promptFrame, /Y Confirm\s+N Cancel/);
  assert.doesNotMatch(promptFrame, /A Activity|W Workspace|D Devices|← Read only|→ System/);
  input.write("y");
  await waitFor(() => changes.length === 1);
  assert.deepEqual(changes, ["system"]);

  await waitFor(() => rendered.includes("OS account permissions, credentials, and network apply"));
  input.write("\u001b[D");
  await waitFor(() => changes.length === 2);
  assert.deepEqual(changes, ["system", "workspace"]);
  await waitFor(() => rendered.includes("Commands off"));
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
      initialNotice: "Glossa 0.2.4 is available. Run glossa update after disconnecting.",
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
  assert.match(rendered, /Glossa 0\.2\.4 is available\. Run glossa update after disconnecting\./);
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
});
