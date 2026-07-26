import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  applyHudEvent,
  initialHudState,
  renderHud,
  runSessionHud,
  type HudStatus,
} from "./ui-hud.js";

const hudDevice = {
  id: "device-1",
  name: "Laptop",
  platform: "Windows",
  lastSeen: "just now",
  status: "1 active worker",
};

test("hud reduces session events into a compact current state", () => {
  let state = initialHudState("/work/glossa");
  state = applyHudEvent(state, { type: "session", root: "/work/glossa", deviceName: "Dev PC" });
  state = applyHudEvent(state, { type: "status", status: { state: "connected", reconnected: false, legacyRelay: false } });
  state = applyHudEvent(state, { type: "activity", phase: "requested", jobType: "run_command", requestId: "1234567890" });
  assert.equal(state.connection, "connected");
  assert.equal(state.deviceName, "Dev PC");
  assert.equal(state.activities.at(-1)?.label, "Command requested");
  state = applyHudEvent(state, { type: "activity", phase: "finished", jobType: "run_command", requestId: "1234567890", ok: true });
  assert.equal(state.activities.at(-1)?.label, "Command started");
  state = applyHudEvent(state, {
    type: "activity",
    phase: "requested",
    jobType: "edit_file",
    requestId: "edit123456",
  });
  assert.equal(state.activities.at(-1)?.label, "File edit requested");
});

test("hud shows retry diagnostics and the next retry timing", () => {
  let state = initialHudState("/work/glossa");
  state = applyHudEvent(state, { type: "status", status: { state: "connecting" } });
  state = applyHudEvent(state, {
    type: "status",
    status: {
      state: "retrying",
      error: new Error("TLS handshake failed"),
      retryInMs: 1_500,
    },
  });
  assert.equal(
    state.message,
    "Could not connect: TLS handshake failed Retrying in 2 seconds.",
  );
  state = applyHudEvent(state, {
    type: "status",
    status: {
      state: "retrying",
      error: new Error("TLS handshake failed"),
      retryInMs: 2_500,
    },
  });
  assert.match(state.message ?? "", /^Could not connect:/);
  state = applyHudEvent(state, {
    type: "status",
    status: { state: "connected", reconnected: false, legacyRelay: false },
  });
  state = applyHudEvent(state, {
    type: "status",
    status: {
      state: "retrying",
      error: new Error("TLS handshake failed"),
      retryInMs: 1_500,
    },
  });
  assert.match(state.message ?? "", /^Connection lost:/);
  assert.match(renderHud(state, 100, false), /Retrying in 2 seconds\./);
});

test("hud defaults to one calm status surface", () => {
  const view = renderHud({ ...initialHudState("/a/very/long/workspace/path"), connection: "connected" }, 42, false);
  assert.match(view, /^  Glossa +SESSION$/m);
  assert.match(view, /^  ─+$/m);
  assert.match(view, /● Connected/);
  assert.match(view, /ChatGPT can use this workspace\./);
  assert.match(view, /WORKSPACE/);
  assert.match(view, /Files and commands use your account\s+permissions\./);
  assert.match(view, /LATEST ACTIVITY/);
  assert.doesNotMatch(view, /AUTHORITY|Full account permissions/);
  assert.match(view, /D Activity +S Status/);
  assert.doesNotMatch(view, /RECENT ACTIVITY/);
});

test("hud renders connected relay compatibility notices", () => {
  let state = initialHudState("/work/glossa");
  state = { ...state, connection: "connected" };
  state = applyHudEvent(state, {
    type: "notice",
    message: "The relay needs an update before this computer can expose several workspaces at once.",
  });
  const view = renderHud(state, 120, false);
  assert.match(view, /relay needs an update/);
});

test("hud keeps the hierarchy readable in a narrow terminal", () => {
  const initial = initialHudState("/work/glossa");
  const view = renderHud(initial, 24, false);
  assert.match(view, /^  Glossa +SESSION$/m);
  assert.match(view, /Q Disconnect/);
  const states = [
    initial,
    { ...initial, view: "activity" as const },
    {
      ...initial,
      view: "status" as const,
      status: {
        account: "dev@example.com",
        relay: "https://mcp.glossa.test",
        activeWorkers: 1,
        devices: [hudDevice],
      },
    },
    { ...initial, view: "help" as const },
  ];
  for (const state of states) {
    for (const line of renderHud(state, 24, false).split("\n")) {
      assert.ok(line.length <= 24, `line exceeds terminal width: ${line}`);
    }
  }
});

test("hud contains account and device management", () => {
  const view = renderHud({
    ...initialHudState("/work/glossa"),
    view: "status",
    status: {
      account: "dev@example.com",
      relay: "https://mcp.glossa.test",
      activeWorkers: 2,
      devices: [hudDevice],
    },
  }, 100, false);
  assert.match(view, /dev@example\.com/);
  assert.match(view, /ACTIVE WORKSPACES/);
  assert.match(view, /DEVICES  1/);
  assert.match(view, /Laptop/);
  assert.match(view, /1 active worker/);
  assert.match(view, /Windows +• +seen just now/);
  assert.match(view, /R Revoke +L Sign out +U Update/);
});

test("hud uses the Glossa paper, purple, coral, ink, and muted palette", () => {
  const view = renderHud(initialHudState("/work/glossa"), 80, true);
  assert.match(view, /\u001b\[38;2;128;84;255;1mGlossa/);
  assert.match(view, /\u001b\[38;2;255;102;95;1mSESSION/);
  assert.match(view, /\u001b\[22;38;2;244;241;251;48;2;17;16;22m/);
  assert.match(view, /\u001b\[38;2;173;152;255;1mWORKSPACE/);
  assert.match(view, /\u001b\[38;2;170;164;181m/);
});


test("hud restores the terminal and propagates session failures", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  input.pause();
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
  });

  await assert.rejects(
    runSessionHud(
      {
        workspace: "/work/glossa",
        async run() {
          throw new Error("startup failed");
        },
        async loadStatus() {
          throw new Error("unused");
        },
        async revokeDevice() {
          throw new Error("unused");
        },
      },
      input as unknown as ReadStream,
      output as unknown as WriteStream,
    ),
    /startup failed/,
  );

  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.match(rendered, /\u001b\[\?1049l/);
});

test("q and Ctrl+C stop the session and release terminal input", async () => {
  for (const [label, sequence] of [["q", "q"], ["Ctrl+C", "\u0003"]] as const) {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value;
        return this;
      },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    setImmediate(() => input.write(sequence));

    const action = await runSessionHud(
      {
        workspace: "/work/glossa",
        async run(signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        async loadStatus() {
          throw new Error("unused");
        },
        async revokeDevice() {
          throw new Error("unused");
        },
      },
      input as unknown as ReadStream,
      output as unknown as WriteStream,
    );

    assert.equal(action, "quit");
    assert.equal(input.isRaw, false, `${label} left raw mode enabled`);
    assert.equal(input.isPaused(), true, `${label} left terminal input flowing`);
  }
});

test("an intentional quit suppresses an abort-driven startup failure", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  setImmediate(() => input.write("q"));

  const action = await runSessionHud(
    {
      workspace: "/work/glossa",
      async run(signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      async loadStatus() {
        throw new Error("unused");
      },
      async revokeDevice() {
        throw new Error("unused");
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  assert.equal(action, "quit");
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
});

test("logout and update are confirmed inside the TUI", async () => {
  for (const [key, expected] of [["l", "logout"], ["u", "update"]] as const) {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value;
        return this;
      },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    setImmediate(() => {
      input.write(key);
      input.write("y");
    });

    const action = await runSessionHud(
      {
        workspace: "/work/glossa",
        async run(signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        async loadStatus() {
          throw new Error("unused");
        },
        async revokeDevice() {
          throw new Error("unused");
        },
      },
      input as unknown as ReadStream,
      output as unknown as WriteStream,
    );

    assert.equal(action, expected);
  }
});

test("status and device revocation stay inside the TUI", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100 });
  let revoked: string | undefined;

  setTimeout(() => input.write("s"), 0);
  setTimeout(() => input.write("r"), 10);
  setTimeout(() => input.write("1"), 20);
  setTimeout(() => input.write("y"), 30);
  setTimeout(() => input.write("q"), 50);

  await runSessionHud(
    {
      workspace: "/work/glossa",
      async run(signal, onEvent) {
        onEvent({
          type: "status",
          status: { state: "connected", reconnected: false, legacyRelay: false },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async loadStatus() {
        return {
          account: "dev@example.com",
          relay: "https://mcp.glossa.test",
          activeWorkers: 1,
          devices: [hudDevice],
        };
      },
      async revokeDevice(deviceId) {
        revoked = deviceId;
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  assert.equal(revoked, "device-1");
});

test("status shows cached data while its refresh is still pending", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let rendered = "";
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
  });
  const cached = {
    account: "cached@example.com",
    relay: "https://mcp.glossa.test",
    activeWorkers: 1,
    devices: [hudDevice],
  };

  setImmediate(() => input.write("s"));
  setTimeout(() => input.write("q"), 10);

  await runSessionHud(
    {
      workspace: "/work/glossa",
      peekStatus: () => cached,
      async run(signal, onEvent) {
        onEvent({
          type: "status",
          status: { state: "connected", reconnected: false, legacyRelay: false },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async loadStatus(signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return cached;
      },
      async revokeDevice() {
        throw new Error("unused");
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  assert.match(rendered, /cached@example\.com/);
  assert.doesNotMatch(rendered, /Loading account and devices/);
});

test("status view updates when account details finish", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let rendered = "";
  let publishStatus: ((status: HudStatus) => void) | undefined;
  output.on("data", (chunk: Buffer) => {
    rendered += chunk.toString("utf8");
  });

  setImmediate(() => input.write("s"));
  setTimeout(() => {
    publishStatus?.({
      account: "dev@example.com",
      relay: "https://mcp.glossa.test",
      activeWorkers: 1,
      devices: [hudDevice],
    });
  }, 10);
  setTimeout(() => input.write("q"), 20);

  await runSessionHud(
    {
      workspace: "/work/glossa",
      subscribeStatus(listener) {
        publishStatus = listener;
        return () => {
          publishStatus = undefined;
        };
      },
      async run(signal, onEvent) {
        onEvent({
          type: "status",
          status: { state: "connected", reconnected: false, legacyRelay: false },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async loadStatus() {
        return {
          account: "Loading account…",
          relay: "https://mcp.glossa.test",
          activeWorkers: 1,
          devices: [hudDevice],
        };
      },
      async revokeDevice() {
        throw new Error("unused");
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  assert.match(rendered, /dev@example\.com/);
});

test("quitting aborts an in-flight device revoke", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  let revokeSignal: AbortSignal | undefined;

  setTimeout(() => input.write("s"), 0);
  setTimeout(() => input.write("r"), 10);
  setTimeout(() => input.write("1"), 20);
  setTimeout(() => input.write("y"), 30);
  setTimeout(() => input.write("q"), 40);

  await runSessionHud(
    {
      workspace: "/work/glossa",
      async run(signal, onEvent) {
        onEvent({
          type: "status",
          status: { state: "connected", reconnected: false, legacyRelay: false },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async loadStatus() {
        return {
          account: "dev@example.com",
          relay: "https://mcp.glossa.test",
          activeWorkers: 1,
          devices: [hudDevice],
        };
      },
      async revokeDevice(_deviceId, signal) {
        revokeSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  assert.equal(revokeSignal?.aborted, true);
});
