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
  assert.match(output.split("\n")[0] ?? "", /Glossa\s+Connected/);
  assert.doesNotMatch(output.split("\n")[0] ?? "", /run_command/);
});

test("HUD breadcrumbs identify secondary views", () => {
  const activity = renderHud({ ...connectedState(), view: "activity" }, 80, false, 20);
  const status = renderHud({ ...connectedState(), view: "status" }, 80, false, 20);
  const help = renderHud({ ...connectedState(), view: "help" }, 80, false, 20);

  assert.match(activity.split("\n")[0] ?? "", /Glossa \/ Recent Activity\s+Connected/);
  assert.match(status.split("\n")[0] ?? "", /Glossa \/ Status\s+Connected/);
  assert.match(help.split("\n")[0] ?? "", /Glossa \/ Help\s+Connected/);
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
  assert.doesNotMatch(output, /[●◌×]/);
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
  assert.match(output.split("\n")[0] ?? "", /Glossa \/ Recent Activity \(1-15\/30\)/);
  assert.doesNotMatch(output, /AGENT|last activity/);
  assert.match(output, /file-30\.txt/);
  assert.doesNotMatch(output, /file-1\.txt/);
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
            legacyRelay: false,
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
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  output.rows = 10;
  output.emit("resize");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  input.write("q");

  assert.equal(await run, "quit");
  assert.equal(input.isRaw, false);
  assert.ok(rendered.includes("\u001b]0;Glossa | ink-test\u0007"));
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
});
