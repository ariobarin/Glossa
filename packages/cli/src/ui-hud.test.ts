import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  applyHudEvent,
  initialHudState,
  renderHud,
  runSessionHud,
  type HudState,
} from "./ui-hud.js";

function connectedState(): HudState {
  return {
    ...initialHudState("C:\\code\\glossa"),
    deviceName: "Desk",
    connection: "connected",
    connectedBefore: true,
  };
}

test("keeps the default screen sparse and anchors controls at the bottom", () => {
  const output = renderHud(connectedState(), 60, false, 16);
  const lines = output.split("\n");

  assert.equal(lines.length, 16);
  assert.match(lines[0]!, /Glossa\s+Connected/);
  assert.match(output, /WORKSPACE/);
  assert.match(output, /C:\\code\\glossa/);
  assert.match(output, /DEVICE/);
  assert.doesNotMatch(output, /SESSION/);
  assert.doesNotMatch(output, /ChatGPT can use/i);
  assert.doesNotMatch(output, /account permissions/i);
  assert.doesNotMatch(output, /latest activity/i);
  assert.match(lines.at(-1)!, /Q Quit/);
});

test("shows the active tool in the header and updates one history entry", () => {
  const job = {
    type: "run_command" as const,
    requestId: "request-1",
    argv: ["npm", "run", "check"],
    timeoutMs: 30_000,
  };
  const running = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job,
  });
  assert.match(renderHud(running, 70, false, 18), /Glossa\s+run_command/);
  assert.equal(running.activities.length, 1);
  assert.match(running.activities[0]!.body, /npm/);

  const finished = applyHudEvent(running, {
    type: "activity",
    phase: "returned",
    job,
    ok: true,
  });
  assert.equal(finished.activities.length, 1);
  assert.equal(finished.activities[0]!.state, "returned");
});

test("activity view shows tool names and compact input bodies", () => {
  const withActivity = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "write_file",
      requestId: "request-2",
      path: "README.md",
      content: "updated",
    },
  });
  const output = renderHud(
    { ...withActivity, view: "activity" },
    54,
    false,
    18,
  );

  assert.match(output, /write_file/);
  assert.match(output, /"path":"README\.md"/);
  assert.doesNotMatch(output, /request-2/);
  assert.doesNotMatch(output, /tool call (started|completed)/i);
});

test("status metrics share one-line formatting and contain active devices only", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "status",
      status: {
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: 3,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeen: "just now",
          status: "3 active workers",
        }],
      },
    },
    80,
    false,
    22,
  );

  assert.match(output.split("\n")[0]!, /Glossa\s+Connected/);
  assert.match(output, /Active workspaces\s+3/);
  assert.match(output, /Devices\s+1/);
  assert.match(output, /Device\s+Workers\s+Platform\s+Last seen/);
  assert.match(
    output,
    /Laptop\s+3 active workers\s+win32-x64\s+just now/,
  );
  assert.doesNotMatch(output, /revoked/i);
});

test("status devices use a compact readable row in narrow terminals", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "status",
      status: {
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: 1,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeen: "just now",
          status: "1 active worker",
        }],
      },
    },
    58,
    false,
    22,
  );

  assert.match(
    output,
    /1\s+Laptop · 1 active worker · win32-x64 · just now/,
  );
  assert.doesNotMatch(output, /Device\s+Workers\s+Platform\s+Last seen/);
});

test("status shows every selectable device or an explicit overflow", () => {
  const devices = Array.from({ length: 12 }, (_, index) => ({
    id: `device-${index + 1}`,
    name: `Device ${index + 1}`,
    platform: "win32-x64",
    lastSeen: "just now",
    status: "offline",
  }));
  const output = renderHud(
    {
      ...connectedState(),
      view: "status",
      status: {
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: 0,
        devices,
      },
    },
    70,
    false,
    24,
  );

  assert.match(output, /Devices\s+12/);
  assert.match(output, /Device 8/);
  assert.doesNotMatch(output, /Device 9/);
  assert.match(output, /4 more\. Use glossa devices revoke <id>\./);
});

test("every view stays within a narrow terminal and retains its footer", () => {
  const state = connectedState();
  const views: HudState[] = [
    state,
    {
      ...applyHudEvent(state, {
        type: "activity",
        phase: "started",
        job: {
          type: "read_file",
          requestId: "request-3",
          path: "README.md",
        },
      }),
      view: "activity",
    },
    {
      ...state,
      view: "status",
      status: {
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: null,
        devices: [],
      },
    },
    { ...state, view: "help" },
  ];

  for (const view of views) {
    const lines = renderHud(view, 28, false, 12).split("\n");
    assert.equal(lines.length, 12);
    assert.ok(lines.every((line) => line.length <= 28));
    assert.match(lines.at(-1)!, /Q Quit/);
  }
});

test("help keeps the useful navigation without removed commands", () => {
  const output = renderHud(
    { ...connectedState(), view: "help" },
    60,
    false,
    20,
  );

  assert.match(output, /D\s+Recent activity/);
  assert.match(output, /S\s+Account and devices/);
  assert.match(output, /R\s+Revoke a device/);
  assert.match(output, /L\s+Sign out/);
  assert.match(output, /Q\s+Disconnect and quit/);
  assert.doesNotMatch(output, /update/i);
});

test("rerenders on terminal resize and removes its listener on exit", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };

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
      run: async (signal) => {
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
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeResize = rendered;
  output.columns = 38;
  output.rows = 12;
  output.emit("resize");
  assert.ok(rendered.length > beforeResize.length);
  assert.equal(output.listenerCount("resize"), 1);

  input.emit("keypress", "q", { name: "q" });
  assert.equal(await run, "quit");
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(input.isRaw, false);
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
});
