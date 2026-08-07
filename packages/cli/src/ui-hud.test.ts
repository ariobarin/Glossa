import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  applyHudEvent,
  initialHudState,
  retainPostExitNotice,
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


test("shows the selected access boundary in the workspace screen", () => {
  const session = applyHudEvent(initialHudState("."), {
    type: "session",
    root: "C:\\code\\glossa",
    deviceName: "Desk",
    accessProfile: "system",
  });
  const output = renderHud(
    {
      ...session,
      connection: "connected",
      connectedBefore: true,
    },
    160,
    false,
    20,
  );

  assert.match(output, /ACCESS/);
  assert.match(output, /System access/);
  assert.match(output, /full environment, permissions, credentials, and network access/);
});

test("retains only notices intended for terminal history", () => {
  const hint = "Follow the quickstart.";
  assert.equal(
    retainPostExitNotice(undefined, {
      type: "notice",
      message: hint,
      persistAfterExit: true,
    }),
    hint,
  );
  assert.equal(
    retainPostExitNotice(hint, {
      type: "notice",
      message: "Temporary compatibility warning.",
    }),
    hint,
  );
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
  assert.match(running.activities[0]!.summary.target, /npm/);

  const finished = applyHudEvent(running, {
    type: "activity",
    phase: "returned",
    job,
    ok: true,
  });
  assert.equal(finished.activities.length, 1);
  assert.equal(finished.activities[0]!.state, "returned");
});

test("activity view summarizes file writes without exposing content", () => {
  const withActivity = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "write_file",
      requestId: "request-2",
      path: "packages/cli/src/ui-hud.ts",
      content: "secret payload",
      expectedSha256: "a".repeat(64),
    },
  });
  const output = renderHud(
    { ...withActivity, view: "activity" },
    70,
    false,
    18,
  );

  assert.match(output, /write_file/);
  assert.match(output, /path "packages\/cli\/src\/ui-hud\.ts" · 14 B · guarded/);
  assert.doesNotMatch(output, /secret payload|content|[a-f0-9]{64}/);
  assert.doesNotMatch(output, /request-2/);
  assert.doesNotMatch(output, /tool call (started|completed)/i);
});

test("activity summaries preserve command endpoints as width changes", () => {
  const withActivity = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-3",
      argv: ["npm", "run", "check", "--workspace", "@ariobarin/glossa"],
      stdin: "do not show this",
      timeoutMs: 30_000,
    },
  });
  const state = { ...withActivity, view: "activity" as const };
  const narrow = renderHud(state, 40, false, 18);
  const wide = renderHud(state, 100, false, 18);

  assert.match(narrow, /argv \["npm".*"@ariobarin\/glossa"\]/);
  assert.doesNotMatch(narrow, /stdin|do not show this/);
  assert.match(
    wide,
    /argv \["npm", "run", "check", "--workspace", "@ariobarin\/glossa"\] · stdin 16 B/,
  );
  assert.doesNotMatch(wide, /do not show this/);
});

test("activity summaries preserve search boundaries and command ids", () => {
  const searched = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "search_text",
      requestId: "request-long-search",
      query: "q".repeat(256),
      path: "p".repeat(100),
      timeoutMs: 8_000,
    },
  });
  const commandId = "12345678-1234-4234-8234-123456789abc";
  const commanded = applyHudEvent(searched, {
    type: "activity",
    phase: "started",
    job: {
      type: "get_command",
      requestId: "request-command-id",
      commandId,
    },
  });
  const output = renderHud(
    { ...commanded, view: "activity" },
    70,
    false,
    18,
  );

  assert.match(output, /query "q+…q*" in path "p+…p*"/);
  assert.equal(
    commanded.activities[1]!.summary.target,
    `command ${commandId}`,
  );
  assert.match(output, /command 12345678.*123456789abc/);

  const shortQuery = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "search_text",
      requestId: "request-short-query",
      query: "q",
      path: "p".repeat(100),
      timeoutMs: 8_000,
    },
  });
  const shortQueryOutput = renderHud(
    { ...shortQuery, view: "activity" },
    80,
    false,
    18,
  );
  const summaryLine = shortQueryOutput
    .split("\n")
    .find((line) => line.includes('query "q" in path'));

  assert.equal(summaryLine?.trim().length, 76);
});

test("activity summaries include only non-default command timeouts", () => {
  const defaultTimeout = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-default-timeout",
      argv: ["node", "script.js"],
      timeoutMs: 900_000,
    },
  });
  const customTimeout = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-custom-timeout",
      argv: ["node", "script.js"],
      timeoutMs: 1,
    },
  });

  assert.deepEqual(defaultTimeout.activities[0]!.summary.details, []);
  assert.deepEqual(customTimeout.activities[0]!.summary.details, ["timeout 1 ms"]);
});

test("activity summaries include only non-default read timeouts", () => {
  const defaultList = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-default-list-timeout",
      timeoutMs: 8_000,
    },
  });
  const customList = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-custom-list-timeout",
      timeoutMs: 2_000,
    },
  });
  const customSearch = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "search_text",
      requestId: "request-custom-search-timeout",
      query: "needle",
      timeoutMs: 2_000,
    },
  });
  const customRange = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "read_file_range",
      requestId: "request-custom-range-timeout",
      path: "src/index.ts",
      startLine: 5,
      lineCount: 10,
      timeoutMs: 2_000,
    },
  });

  assert.deepEqual(defaultList.activities[0]!.summary.details, []);
  assert.deepEqual(customList.activities[0]!.summary.details, ["timeout 2000 ms"]);
  assert.deepEqual(customSearch.activities[0]!.summary.details, ["timeout 2000 ms"]);
  assert.deepEqual(customRange.activities[0]!.summary.details, [
    "lines 5\u201314",
    "timeout 2000 ms",
  ]);
});

test("activity summaries include only non-default command start waits", () => {
  const defaultWait = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-default-wait",
      argv: ["node", "script.js"],
      timeoutMs: 900_000,
      waitMs: 750,
    },
  });
  const noWait = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-no-wait",
      argv: ["node", "script.js"],
      timeoutMs: 900_000,
      waitMs: 0,
    },
  });
  const longWait = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-long-wait",
      argv: ["node", "script.js"],
      timeoutMs: 900_000,
      waitMs: 5_000,
    },
  });

  assert.deepEqual(defaultWait.activities[0]!.summary.details, []);
  assert.deepEqual(noWait.activities[0]!.summary.details, ["wait 0 ms"]);
  assert.deepEqual(longWait.activities[0]!.summary.details, ["wait 5000 ms"]);
});

test("bounds stored command summaries while preserving endpoints", () => {
  const state = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-large-command",
      argv: ["node", "a".repeat(100_000), "final-target.ts"],
      timeoutMs: 30_000,
    },
  });
  const target = state.activities[0]!.summary.target;

  assert.ok(target.length <= 512);
  assert.match(target, /^argv \["node", "a+/);
  assert.match(target, /…/);
  assert.match(target, /"final-target\.ts"\]$/);
});

test("activity summary bounds preserve Unicode scalar boundaries", () => {
  const state = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "read_file",
      requestId: "request-unicode-boundary",
      path: `${"a".repeat(222)}😀${"b".repeat(1_000)}`,
    },
  });
  const target = state.activities[0]!.summary.target;

  assert.equal(Buffer.from(target, "utf8").toString("utf8"), target);
  assert.doesNotMatch(target, /�/);
});

test("activity summaries distinguish literal escapes from controls", () => {
  const literalPath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "read_file",
      requestId: "request-literal-path",
      path: "literal\\n.txt",
    },
  });
  const controlPath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "read_file",
      requestId: "request-control-path",
      path: "literal\n.txt",
    },
  });
  assert.equal(literalPath.activities[0]!.summary.target, 'path "literal\\\\n.txt"');
  assert.equal(controlPath.activities[0]!.summary.target, 'path "literal\\n.txt"');
  assert.notEqual(
    literalPath.activities[0]!.summary.target,
    controlPath.activities[0]!.summary.target,
  );

  const formatPath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "read_file",
      requestId: "request-format-path",
      path: "fo\u200bo\u2060\u{e0001}\ufe0f\u034f.txt",
    },
  });
  assert.equal(
    formatPath.activities[0]!.summary.target,
    'path "fo\\u200bo\\u2060\\u{e0001}\\ufe0f\\u034f.txt"',
  );

  const argv = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-shellish-argv",
      argv: ["node", "$HOME", "*", "a;id", "two words", "literal\\n", "actual\n"],
      timeoutMs: 30_000,
    },
  });
  assert.equal(
    argv.activities[0]!.summary.target,
    'argv ["node", "$HOME", "*", "a;id", "two words", "literal\\\\n", "actual\\n"]',
  );

  const literalShell = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-literal-shell",
      shellCommand: "printf \\n",
      timeoutMs: 30_000,
    },
  });
  const controlShell = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-control-shell",
      shellCommand: "printf \n",
      timeoutMs: 30_000,
    },
  });
  assert.equal(literalShell.activities[0]!.summary.target, 'shell "printf \\\\n"');
  assert.equal(controlShell.activities[0]!.summary.target, 'shell "printf \\n"');
});

test("activity summaries quote targets and normalize empty paths", () => {
  const delimiterPath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-delimiter-path",
      path: "src · recursive",
      timeoutMs: 8_000,
    },
  });
  const recursivePath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-recursive-path",
      path: "src",
      recursive: true,
      timeoutMs: 8_000,
    },
  });
  assert.deepEqual(delimiterPath.activities[0]!.summary, {
    target: 'path "src · recursive"',
    details: [],
    truncation: "middle",
  });
  assert.deepEqual(recursivePath.activities[0]!.summary, {
    target: 'path "src"',
    details: ["recursive"],
    truncation: "middle",
  });

  const continuedPath = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-continued-path",
      path: "src",
      cursor: "src/a · recursive\n\u200b",
      timeoutMs: 8_000,
    },
  });
  assert.deepEqual(continuedPath.activities[0]!.summary, {
    target: 'path "src"',
    details: ['after "src/a · recursive\\n\\u200b"'],
    truncation: "middle",
  });

  const delimiterShell = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-delimiter-shell",
      shellCommand: "echo · stdin 1 B",
      timeoutMs: 900_000,
    },
  });
  const stdinShell = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-stdin-shell",
      shellCommand: "echo",
      stdin: "x",
      timeoutMs: 900_000,
    },
  });
  assert.deepEqual(delimiterShell.activities[0]!.summary, {
    target: 'shell "echo · stdin 1 B"',
    details: [],
    truncation: "middle",
  });
  assert.deepEqual(stdinShell.activities[0]!.summary, {
    target: 'shell "echo"',
    details: ["stdin 1 B"],
    truncation: "middle",
  });

  const emptyList = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "list_files",
      requestId: "request-empty-list",
      path: "",
      timeoutMs: 8_000,
    },
  });
  const emptySearch = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "search_text",
      requestId: "request-empty-search",
      query: "needle",
      path: "",
      timeoutMs: 8_000,
    },
  });
  assert.equal(emptyList.activities[0]!.summary.target, 'path "."');
  assert.equal(
    emptySearch.activities[0]!.summary.target,
    'query "needle" in path "."',
  );
});

test("activity summaries skip oversized details and keep later metadata", () => {
  const withActivity = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "search_text",
      requestId: "request-long-extensions",
      query: "needle",
      path: ".",
      extensions: Array.from({ length: 20 }, () => ".verylongextension"),
      caseSensitive: true,
      maxResults: 5,
      timeoutMs: 8_000,
    },
  });
  const output = renderHud(
    { ...withActivity, view: "activity" },
    70,
    false,
    18,
  );

  assert.doesNotMatch(output, /extensions/);
  assert.match(output, /case-sensitive · limit 5/);
});

test("activity summaries hide edit text and escape terminal controls", () => {
  const edited = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job: {
      type: "edit_file",
      requestId: "request-4",
      path: "packages/cli/src/ui-hud.ts",
      edits: [{ oldText: "private secret", newText: "replacement" }],
      expectedSha256: "b".repeat(64),
    },
  });
  const commanded = applyHudEvent(edited, {
    type: "activity",
    phase: "started",
    job: {
      type: "run_command",
      requestId: "request-5",
      argv: ["node", "script.js\n\u001b[2J\u202e", "\u2066target.ts\u2069"],
      timeoutMs: 30_000,
    },
  });
  const output = renderHud(
    { ...commanded, view: "activity" },
    90,
    false,
    22,
  );

  assert.match(output, /path "packages\/cli\/src\/ui-hud\.ts" · 1 edit · guarded/);
  assert.doesNotMatch(output, /private secret|replacement|oldText|newText/);
  assert.match(output, /script\.js\\n\\u001b\[2J\\u202e/);
  assert.match(output, /\\u2066target\.ts\\u2069/);
  assert.doesNotMatch(output, /\u001b/);
});

test("activity clipping keeps the newest complete entries", () => {
  const activities = Array.from({ length: 8 }, (_, index) => ({
    tool: "read_file" as const,
    summary: {
      target: `file-${index + 1}.txt`,
      details: [],
      truncation: "middle" as const,
    },
    requestId: `request-${index + 1}`,
    state: "returned" as const,
  }));
  const output = renderHud(
    { ...connectedState(), view: "activity", activities },
    70,
    false,
    24,
  );

  assert.doesNotMatch(output, /file-[12]\.txt/);
  for (let index = 3; index <= 8; index += 1) {
    assert.match(output, new RegExp(`file-${index}\\.txt`));
  }
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
  assert.match(output, /3 Active workspaces/);
  assert.match(output, /1 Devices/);
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

test("status accents active worker counts but keeps offline devices muted", () => {
  const output = renderHud(
    {
      ...connectedState(),
      view: "status",
      status: {
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: 1,
        devices: [
          {
            id: "device-1",
            name: "Active laptop",
            platform: "win32-x64",
            lastSeen: "just now",
            status: "1 active worker",
          },
          {
            id: "device-2",
            name: "Offline laptop",
            platform: "win32-x64",
            lastSeen: "2h ago",
            status: "offline",
          },
        ],
      },
    },
    80,
    true,
    24,
  );

  assert.match(output, /\u001b\[38;2;173;152;255m1 active worker/);
  assert.match(output, /\u001b\[38;2;170;164;181moffline/);
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

  assert.match(output, /12 Devices/);
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
  const framesBeforeResize =
    rendered.split("\u001b[H\u001b[2J").length - 1;
  for (let index = 0; index < 100; index += 1) {
    output.columns = 38 + index % 2;
    output.rows = 12 + index % 2;
    output.emit("resize");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  const framesAfterResize =
    rendered.split("\u001b[H\u001b[2J").length - 1;
  assert.equal(framesAfterResize, framesBeforeResize + 1);
  assert.equal(output.listenerCount("resize"), 1);

  input.emit("keypress", "q", { name: "q" });
  assert.equal(await run, "quit");
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(input.isRaw, false);
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
});

test("resize cannot revoke a device hidden after prompting", async () => {
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
  output.columns = 58;
  output.rows = 22;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });

  const devices = Array.from({ length: 12 }, (_, index) => ({
    id: `device-${index + 1}`,
    name: `Device ${index + 1}`,
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
            legacyRelay: false,
          },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      loadStatus: async () => ({
        account: "dev@example.com",
        relay: "https://relay.example",
        activeWorkers: 0,
        devices,
      }),
      revokeDevice: async (deviceId) => {
        revoked.push(deviceId);
      },
    },
    input as unknown as ReadStream,
    output as unknown as WriteStream,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  input.emit("keypress", "s", { name: "s" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  input.emit("keypress", "r", { name: "r" });
  output.rows = 14;
  output.emit("resize");
  input.emit("keypress", "3", { name: "3" });
  input.emit("keypress", "y", { name: "y" });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(revoked, []);
  assert.match(rendered, /Increase the terminal height to choose a device/);

  output.rows = 22;
  output.emit("resize");
  input.emit("keypress", "r", { name: "r" });
  input.emit("keypress", "1", { name: "1" });
  output.rows = 14;
  output.emit("resize");
  input.emit("keypress", "y", { name: "y" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(revoked, []);

  output.rows = 22;
  output.emit("resize");
  input.emit("keypress", "r", { name: "r" });
  input.emit("keypress", "1", { name: "1" });
  input.emit("keypress", "y", { name: "y" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(revoked, ["device-1"]);
  assert.match(rendered, /Revoked Device 1\./);

  input.emit("keypress", "q", { name: "q" });
  assert.equal(await run, "quit");
});
