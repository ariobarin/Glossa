import assert from "node:assert/strict";
import test from "node:test";
import { renderHud } from "./ui-hud.js";
import {
  applyHudEvent,
  initialHudState,
  retainPostExitNotice,
  type HudState,
} from "./ui-hud-model.js";

function connectedState(): HudState {
  return {
    ...initialHudState("C:\\code\\glossa"),
    deviceName: "Desk",
    connection: "connected",
    connectedBefore: true,
  };
}

test("workspace is the default view with an activity preview", () => {
  const output = renderHud(connectedState(), 60, false, 16);
  const lines = output.split("\n");

  assert.equal(lines.length, 16);
  assert.match(lines[0]!, /Glossa \/ Workspace\s+Connected/);
  assert.match(output, /WORKSPACE/);
  assert.match(output, /DEVICE/);
  assert.match(output, /ACTIVITY\s+A View all/);
  assert.match(output, /No activity yet/);
  assert.match(lines.slice(-3).join("\n"), /A Activity/);
  assert.match(lines.slice(-3).join("\n"), /W Workspace/);
  assert.match(lines.slice(-3).join("\n"), /D Devices/);
  assert.doesNotMatch(output, /AGENT/);
  assert.match(lines.slice(-3).join("\n"), /Q Quit/);
});

test("workspace activity preview shows only the newest rows", () => {
  const now = Date.now();
  const activities = Array.from({ length: 5 }, (_, index) => ({
    tool: "read_file" as const,
    summary: {
      target: `path \"file-${index + 1}.txt\"`,
      details: [],
      truncation: "middle" as const,
    },
    requestId: `request-${index + 1}`,
    state: "returned" as const,
    updatedAt: now,
  }));
  const output = renderHud({ ...connectedState(), activities }, 80, false, 24, now);

  assert.match(output, /file-3\.txt/);
  assert.match(output, /file-4\.txt/);
  assert.match(output, /file-5\.txt/);
  assert.doesNotMatch(output, /file-1\.txt|file-2\.txt/);
});

test("activity view keeps state and age on the activity row", () => {
  const empty = renderHud(
    { ...connectedState(), view: "activity" },
    70,
    false,
    22,
  );
  assert.doesNotMatch(empty, /AGENT/);
  assert.match(empty.split("\n")[0]!, /Glossa \/ Activity\s+Connected/);
  assert.doesNotMatch(empty, /ACTION\s+DETAILS\s+WHEN/);
  assert.match(empty, /No activity yet/);

  const job = {
    type: "read_file" as const,
    requestId: "agent-request",
    path: "packages/cli/src/ui-hud.ts",
  };
  const activeState = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job,
  });
  const active = renderHud(
    { ...activeState, view: "activity" },
    70,
    false,
    22,
  );
  const activeRow = active.split("\n").find((line) => line.includes('path "packages/cli/src/ui-hud.ts"'));
  assert.match(
    activeRow ?? "",
    /○\s+read_file\s+path "packages\/cli\/src\/ui-hud\.ts"\s+now$/,
  );

  const idleState = applyHudEvent(activeState, {
    type: "activity",
    phase: "returned",
    job,
    ok: true,
  });
  const idle = renderHud(
    { ...idleState, view: "activity" },
    70,
    false,
    22,
  );
  assert.doesNotMatch(idle, /AGENT|last activity/);
  const idleRow = idle.split("\n").find((line) => line.includes('path "packages/cli/src/ui-hud.ts"'));
  assert.match(
    idleRow ?? "",
    /✓\s+read_file\s+path "packages\/cli\/src\/ui-hud\.ts"\s+just now$/,
  );
});

test("activity history is bounded to 999 entries", () => {
  let state = connectedState();
  for (let index = 1; index <= 1_002; index += 1) {
    state = applyHudEvent(state, {
      type: "activity",
      phase: "returned",
      job: {
        type: "read_file",
        requestId: `request-${index}`,
        path: `file-${index}.txt`,
      },
      ok: true,
    });
  }
  assert.equal(state.activities.length, 999);
  assert.equal(state.activities[0]!.requestId, "request-4");
  assert.equal(state.activities.at(-1)!.requestId, "request-1002");
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
      view: "workspace",
      connection: "connected",
      connectedBefore: true,
    },
    160,
    false,
    20,
  );

  assert.match(output, /ACCESS\s+← Switch/);
  assert.match(output, /System\s+Read \+ write files \+ commands\s+OS account permissions apply/);
  assert.doesNotMatch(output, /Read only\s+─\s+Workspace\s+─\s+\[ System \]/);
});

test("access handoff keeps connection health stable until replacement connects", () => {
  let state: HudState = {
    ...connectedState(),
    view: "workspace",
    accessProfile: "workspace",
    pendingAccessProfile: "system",
  };

  state = applyHudEvent(state, {
    type: "session",
    root: "C:\\code\\glossa",
    deviceName: "Desk",
    accessProfile: "system",
  });
  assert.equal(state.connection, "connected");
  assert.equal(state.accessProfile, "system");
  assert.equal(state.pendingAccessProfile, "system");

  const connecting = applyHudEvent(state, {
    type: "status",
    status: { state: "connecting" },
  });
  assert.equal(connecting.connection, "connected");
  assert.equal(connecting.pendingAccessProfile, "system");

  const retrying = applyHudEvent(connecting, {
    type: "status",
    status: { state: "retrying", error: new Error("handoff"), retryInMs: 500 },
  });
  assert.equal(retrying.connection, "connected");
  assert.equal(retrying.message, undefined);

  const connected = applyHudEvent(retrying, {
    type: "status",
    status: {
      state: "connected",
      reconnected: true,
    },
  });
  assert.equal(connected.connection, "connected");
  assert.equal(connected.pendingAccessProfile, undefined);
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

test("keeps the connection status stable while activity updates history", () => {
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
  assert.match(renderHud(running, 70, false, 18).split("\n")[0]!, /Connected$/);
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
    90,
    false,
    18,
  );

  assert.match(output, /write_file/);
  assert.match(output, /path "packages\/cli\/src\/ui-hud\.ts" · 14 B · guarded/);
  assert.doesNotMatch(output, /secret payload|content|[a-f0-9]{64}/);
  assert.doesNotMatch(output, /request-2/);
  assert.doesNotMatch(output, /tool call (started|completed)/i);
});

test("activity command summaries preserve argv endpoints without stdin content", () => {
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
  const summary = withActivity.activities[0]!.summary;

  assert.equal(
    summary.target,
    'argv ["npm", "run", "check", "--workspace", "@ariobarin/glossa"]',
  );
  assert.deepEqual(summary.details, ["stdin 16 B", "timeout 30000 ms"]);
  assert.doesNotMatch(`${summary.target} ${summary.details.join(" ")}`, /do not show this/);
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
  const searchSummary = searched.activities[0]!.summary;
  assert.match(searchSummary.target, /^query "q+/);
  assert.match(searchSummary.target, /" in path "p+"$/);
  assert.equal(searchSummary.targetSegments?.[1], " in ");

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
  assert.equal(commanded.activities[1]!.summary.target, `command ${commandId}`);

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
  assert.equal(shortQuery.activities[0]!.summary.targetSegments?.[0], 'query "q"');
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
    90,
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
    120,
    false,
    22,
  );

  assert.match(output, /path "packages\/cli\/src\/ui-hud\.ts" · 1 edit · guarded/);
  assert.doesNotMatch(output, /private secret|replacement|oldText|newText/);
  assert.match(output, /script\.js\\n\\u001b\[2J\\u202e/);
  assert.match(output, /\\u2066target\.ts\\u2069/);
  assert.doesNotMatch(output, /\u001b/);
});

test("activity pagination shows newest entries and range only when needed", () => {
  const activities = Array.from({ length: 22 }, (_, index) => ({
    tool: "read_file" as const,
    summary: {
      target: `file-${index + 1}.txt`,
      details: [],
      truncation: "middle" as const,
    },
    requestId: `request-${index + 1}`,
    state: "returned" as const,
  }));
  const newest = renderHud(
    { ...connectedState(), view: "activity", activities },
    70,
    false,
    24,
  );

  assert.match(newest.split("\n")[0]!, /Glossa \/ Activity \(1-18\/22\)/);
  assert.doesNotMatch(newest, /file-[1234]\.txt/);
  for (let index = 5; index <= 22; index += 1) {
    assert.match(newest, new RegExp(`file-${index}\\.txt`));
  }

  const older = renderHud(
    { ...connectedState(), view: "activity", activityPage: 1, activities },
    70,
    false,
    24,
  );
  assert.match(older.split("\n")[0]!, /Glossa \/ Activity \(19-22\/22\)/);
  assert.match(older, /file-1\.txt/);
  assert.match(older, /file-4\.txt/);
  assert.doesNotMatch(older, /file-(?:5|22)\.txt/);

  const unpaged = renderHud(
    { ...connectedState(), view: "activity", activities: activities.slice(-4) },
    70,
    false,
    24,
  );
  assert.match(unpaged.split("\n")[0]!, /Glossa \/ Activity\s+Connected/);
  assert.doesNotMatch(unpaged.split("\n")[0]!, /Activity \(/);
});

test("devices page shows pairing overview and active devices", () => {
  const now = Date.parse("2026-08-17T21:00:00Z");
  const output = renderHud(
    {
      ...connectedState(),
      view: "devices",
      status: {
        relay: "https://relay.example",
        activeWorkers: 3,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeenAt: new Date(now).toISOString(),
          status: "3 active workers",
        }],
      },
    },
    80,
    false,
    22,
    now,
  );

  assert.match(output.split("\n")[0]!, /Glossa \/ Devices\s+Connected/);
  assert.match(output, /3 Active workspaces/);
  assert.match(output, /1 Devices/);
  assert.match(output, /Device\s+Workers\s+Platform\s+Last seen/);
  assert.match(
    output,
    /Laptop\s+3 active workers\s+win32-x64\s+just now/,
  );
  assert.doesNotMatch(output, /revoked/i);
});

test("devices use a compact readable row in narrow terminals", () => {
  const now = Date.parse("2026-08-17T21:00:00Z");
  const output = renderHud(
    {
      ...connectedState(),
      view: "devices",
      status: {
        relay: "https://relay.example",
        activeWorkers: 1,
        devices: [{
          id: "device-1",
          name: "Laptop",
          platform: "win32-x64",
          lastSeenAt: new Date(now).toISOString(),
          status: "1 active worker",
        }],
      },
    },
    58,
    false,
    22,
    now,
  );

  assert.match(
    output,
    /›\s+Laptop · 1 active worker · win32-x64 · just now/,
  );
  assert.doesNotMatch(output, /Device\s+Workers\s+Platform\s+Last seen/);
});

test("devices derive last seen from timestamps at render time", () => {
  const now = Date.parse("2026-08-17T21:00:00Z");
  const state: HudState = {
    ...connectedState(),
    view: "devices",
    status: {
      relay: "https://relay.example",
      activeWorkers: 0,
      devices: [{
        id: "device-1",
        name: "Laptop",
        platform: "win32-x64",
        lastSeenAt: new Date(now - 60_000).toISOString(),
        status: "offline",
      }],
    },
  };

  assert.match(renderHud(state, 80, false, 22, now), /1m ago/);
  assert.match(renderHud(state, 80, false, 22, now + 60_000), /2m ago/);
});

test("devices view scrolls to keep the selected device visible", () => {
  const devices = Array.from({ length: 12 }, (_, index) => ({
    id: `device-${index + 1}`,
    name: `Device ${index + 1}`,
    platform: "win32-x64",
    lastSeenAt: null,
    status: "offline",
  }));
  const output = renderHud(
    {
      ...connectedState(),
      view: "devices",
      deviceSelection: 10,
      status: {
        relay: "https://relay.example",
        activeWorkers: 0,
        devices,
      },
    },
    70,
    false,
    24,
  );

  assert.match(output.split("\n")[0]!, /Glossa \/ Devices \(3-11\/12\)/);
  assert.match(output, /›\s+Device 11/);
  assert.doesNotMatch(output, /Device 1\s/);
  assert.doesNotMatch(output, /Device 12/);
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
      view: "devices",
      status: {
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
    assert.match(lines.slice(-3).join("\n"), /Q Quit/);
  }
});

test("help keeps the useful navigation without removed commands", () => {
  const output = renderHud(
    { ...connectedState(), view: "help" },
    60,
    false,
    20,
  );

  assert.match(output, /A\s+Activity/);
  assert.match(output, /D\s+Devices/);
  assert.match(output, /\?\s+Help/);
  assert.match(output, /Esc\s+Workspace/);
  assert.match(output, /Enter\/R\s+Revoke selected device/);
  assert.match(output, /Q\s+Disconnect and quit/);
  assert.doesNotMatch(output, /sign out/i);
  assert.doesNotMatch(output, /update/i);
});


