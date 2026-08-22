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

test("workspace is quiet until there is activity", () => {
  const output = renderHud(connectedState(), 60, false, 16);
  const lines = output.split("\n");

  assert.equal(lines.length, 16);
  assert.match(lines[0]!, /Glossa \/ Workspace\s+Connected/);
  assert.match(output, /C:\\code\\glossa/);
  assert.match(output, /Device\s+Desk/);
  assert.doesNotMatch(output, /ACTIVITY|No activity yet|View all|AGENT/);
  assert.match(lines.slice(-3).join("\n"), /A Activity/);
  assert.match(lines.slice(-3).join("\n"), /W Workspace/);
  assert.match(lines.slice(-3).join("\n"), /D Devices/);
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

  assert.match(output, /ACTIVITY\s+A View all/);
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
  const activeRow = active.split("\n").find((line) => line.includes("packages/cli/src/ui-hud.ts"));
  assert.match(
    activeRow ?? "",
    /○\s+read_file\s+packages\/cli\/src\/ui-hud\.ts\s+now$/,
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
  assert.equal(idleState.activities[0]?.startedAt, activeState.activities[0]?.startedAt);
  const idleRow = idle.split("\n").find((line) => line.includes("packages/cli/src/ui-hud.ts"));
  assert.match(
    idleRow ?? "",
    /✓\s+read_file\s+packages\/cli\/src\/ui-hud\.ts\s+just now$/,
  );
});

test("activity history is bounded to 9,999 entries", () => {
  let state = connectedState();
  for (let index = 1; index <= 10_002; index += 1) {
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
  assert.equal(state.activities.length, 9_999);
  assert.equal(state.activities[0]!.requestId, "request-4");
  assert.equal(state.activities.at(-1)!.requestId, "request-10002");
});

test("coalesces only unchanged command polls with a valid sequence", () => {
  const commandId = "00000000-0000-4000-8000-000000000051";
  const otherCommandId = "00000000-0000-4000-8000-000000000052";
  const job = (requestId: string, id = commandId) => ({
    type: "get_command" as const,
    requestId,
    commandId: id,
  });
  const started = (requestId: string, id = commandId) => ({
    type: "activity" as const,
    phase: "started" as const,
    job: job(requestId, id),
  });
  const returned = (
    requestId: string,
    output: {
      commandId?: string;
      kind: "success" | "error" | "running";
      preview?: string;
      sequence?: number;
    },
    ok = true,
    id = commandId,
  ) => ({
    type: "activity" as const,
    phase: "returned" as const,
    job: job(requestId, id),
    ok,
    output,
  });

  let state = applyHudEvent(connectedState(), started("request-command-1"));
  assert.equal(state.activities.length, 1);
  assert.equal(state.activities[0]!.state, "working");
  state = applyHudEvent(
    state,
    returned("request-command-1", {
      commandId,
      kind: "running",
      preview: "working",
      sequence: 3,
    }),
  );
  assert.equal(state.activities.length, 1);

  const retained = state.activities[0]!;
  state = {
    ...state,
    activitySelection: retained.requestId,
    activityBrowseAnchor: retained.requestId,
  };
  const beforeRepeat = state;
  state = applyHudEvent(state, started("request-command-2"));
  assert.strictEqual(state, beforeRepeat);
  state = applyHudEvent(
    state,
    returned("request-command-2", {
      commandId,
      kind: "running",
      preview: "working",
      sequence: 3,
    }),
  );
  assert.strictEqual(state, beforeRepeat);
  assert.deepEqual(state.activities[0], retained);
  assert.equal(state.activitySelection, retained.requestId);
  assert.equal(state.activityBrowseAnchor, retained.requestId);

  state = applyHudEvent(state, started("request-command-3"));
  assert.strictEqual(state, beforeRepeat);
  state = applyHudEvent(
    state,
    returned("request-command-3", {
      commandId,
      kind: "running",
      preview: "working",
      sequence: 4,
    }),
  );
  assert.equal(state.activities.length, 2);
  assert.equal(state.activities[1]!.requestId, "request-command-3");

  state = applyHudEvent(state, started("request-command-4"));
  assert.equal(state.activities.length, 2);
  state = applyHudEvent(
    state,
    returned("request-command-4", {
      commandId,
      kind: "running",
      preview: "more output",
      sequence: 4,
    }),
  );
  assert.equal(state.activities.length, 3);
  state = applyHudEvent(state, started("request-command-5"));
  assert.equal(state.activities.length, 3);
  state = applyHudEvent(
    state,
    returned("request-command-5", {
      commandId,
      kind: "success",
      preview: "more output",
      sequence: 4,
    }),
  );
  assert.equal(state.activities.length, 4);

  state = applyHudEvent(state, started("request-command-6", otherCommandId));
  assert.equal(state.activities.length, 5);
  state = applyHudEvent(
    state,
    returned(
      "request-command-6",
      {
        commandId: otherCommandId,
        kind: "running",
        preview: "more output",
        sequence: 4,
      },
      true,
      otherCommandId,
    ),
  );
  assert.equal(state.activities.length, 5);

  state = applyHudEvent(state, started("request-command-7"));
  assert.equal(state.activities.length, 5);
  state = applyHudEvent(
    state,
    returned("request-command-7", { kind: "success", preview: "more output" }),
  );
  assert.equal(state.activities.length, 6);
  assert.equal(state.activities[5]!.requestId, "request-command-7");

  state = applyHudEvent(state, started("request-command-8"));
  assert.equal(state.activities.length, 6);
  state = applyHudEvent(
    state,
    returned(
      "request-command-8",
      { commandId, kind: "error", preview: "poll failed", sequence: 4 },
      false,
    ),
  );
  assert.equal(state.activities.length, 7);
  assert.equal(state.activities[6]!.requestId, "request-command-8");
});

test("coalesces command polls after call metadata expires", () => {
  const commandId = "00000000-0000-4000-8000-000000000061";
  const retained = {
    tool: "get_command" as const,
    summary: {
      target: `command ${commandId}`,
      details: [],
      truncation: "middle" as const,
    },
    callUnavailable: "expired" as const,
    output: {
      commandId,
      kind: "running" as const,
      preview: "working",
      sequence: 7,
    },
    requestId: "request-retained-command",
    state: "returned" as const,
    startedAt: 100,
    updatedAt: 200,
  };
  const beforeRepeat = {
    ...connectedState(),
    activities: [retained],
    activitySelection: retained.requestId,
    activityBrowseAnchor: retained.requestId,
  };
  const job = {
    type: "get_command" as const,
    requestId: "request-repeat-command",
    commandId,
  };

  const legacyState = {
    ...beforeRepeat,
    activities: [{
      ...retained,
      output: { kind: "running" as const, preview: "working", sequence: 7 },
    }],
  };
  const legacyStarted = applyHudEvent(legacyState, {
    type: "activity",
    phase: "started",
    job,
  });
  assert.equal(legacyStarted.activities.length, 2);
  assert.equal(legacyStarted.activities[1]!.requestId, job.requestId);

  const started = applyHudEvent(beforeRepeat, {
    type: "activity",
    phase: "started",
    job,
  });
  assert.strictEqual(started, beforeRepeat);
  const returned = applyHudEvent(started, {
    type: "activity",
    phase: "returned",
    job,
    ok: true,
    output: {
      commandId,
      kind: "running",
      preview: "working",
      sequence: 7,
    },
  });
  assert.strictEqual(returned, beforeRepeat);
  assert.deepEqual(returned.activities[0], retained);
  assert.equal(returned.activitySelection, retained.requestId);
  assert.equal(returned.activityBrowseAnchor, retained.requestId);
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

  assert.match(output, /Access\s+System · read \+ write files \+ commands/);
  assert.match(output, /OS permissions · credentials · network/);
  assert.match(output, /← Switch/);
});

test("access handoff keeps the old authority visible until replacement connects", () => {
  let state: HudState = {
    ...connectedState(),
    view: "workspace",
    connection: "connecting",
    accessProfile: "workspace",
    pendingAccessProfile: "system",
  };

  state = applyHudEvent(state, {
    type: "session",
    root: "C:\\code\\glossa",
    deviceName: "Desk",
    accessProfile: "system",
  });
  assert.equal(state.connection, "connecting");
  assert.equal(state.accessProfile, "workspace");
  assert.equal(state.pendingAccessProfile, "system");

  const connecting = applyHudEvent(state, {
    type: "status",
    status: { state: "connecting" },
  });
  assert.equal(connecting.connection, "connecting");
  assert.equal(connecting.accessProfile, "workspace");

  const retrying = applyHudEvent(connecting, {
    type: "status",
    status: { state: "retrying", error: new Error("handoff"), retryInMs: 500 },
  });
  assert.equal(retrying.connection, "retrying");
  assert.match(retrying.message ?? "", /Connection lost: handoff\. Retrying in 1 second\./);

  const connected = applyHudEvent(retrying, {
    type: "status",
    status: {
      state: "connected",
      reconnected: true,
    },
  });
  assert.equal(connected.connection, "connected");
  assert.equal(connected.accessProfile, "system");
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
  assert.match(output, /packages\/cli\/src\/ui-hud\.ts · 14 B · guarded/);
  assert.deepEqual(withActivity.activities[0]?.call, {
    type: "write_file",
    path: "packages/cli/src/ui-hud.ts",
    contentBytes: 14,
    expectedSha256: "a".repeat(64),
  });
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
    { ...withActivity, view: "activity", activityMode: "detailed" },
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
    { ...commanded, view: "activity", activityMode: "detailed" },
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

test("activity browse window follows the tail and anchors older pages", () => {
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

  assert.match(newest.split("\n")[0]!, /Glossa \/ Activity \(\d+-22\/22\)/);
  assert.match(newest, /✓\s+read_file\s+file-22\.txt/);
  assert.doesNotMatch(newest, /›/);

  const anchoredState = {
    ...connectedState(),
    view: "activity" as const,
    activityBrowseAnchor: "request-10",
    activities,
  };
  const older = renderHud(anchoredState, 70, false, 24);
  assert.match(older.split("\n")[0]!, /Glossa \/ Activity \(1-10\/22\)/);
  assert.match(older, /file-1\.txt/);
  assert.match(older, /file-10\.txt/);
  assert.doesNotMatch(older, /file-(?:11|22)\.txt/);

  const appended = [
    ...activities,
    {
      tool: "read_file" as const,
      summary: { target: "file-23.txt", details: [], truncation: "middle" as const },
      requestId: "request-23",
      state: "returned" as const,
    },
  ];
  const stable = renderHud({ ...anchoredState, activities: appended }, 70, false, 24);
  assert.match(stable.split("\n")[0]!, /Glossa \/ Activity \(1-10\/23\)/);
  assert.doesNotMatch(stable, /file-23\.txt/);

  const unwindowed = renderHud(
    { ...connectedState(), view: "activity", activities: activities.slice(-4) },
    70,
    false,
    24,
  );
  assert.match(unwindowed.split("\n")[0]!, /Glossa \/ Activity\s+Connected/);
  assert.doesNotMatch(unwindowed.split("\n")[0]!, /Activity \(/);
});

test("activity events never activate or move the selection cursor", () => {
  let state = connectedState();
  const event = (requestId: string, path: string) => ({
    type: "activity" as const,
    phase: "started" as const,
    job: {
      type: "read_file" as const,
      requestId,
      path,
    },
  });

  state = applyHudEvent(state, event("request-1", "one.ts"));
  state = applyHudEvent(state, event("request-2", "two.ts"));
  assert.equal(state.activitySelection, undefined);
  assert.equal(state.activityBrowseAnchor, undefined);

  state = {
    ...state,
    activitySelection: "request-1",
    activityBrowseAnchor: "request-1",
  };
  state = applyHudEvent(state, event("request-3", "three.ts"));
  assert.equal(state.activitySelection, "request-1");
  assert.equal(state.activityBrowseAnchor, "request-1");

});

test("activity inspect renders complete safe invocation metadata", () => {
  const stdin = "private stdin body";
  const job = {
    type: "run_command" as const,
    requestId: "00000000-0000-4000-8000-000000000009",
    argv: [
      "npm",
      "run",
      "check",
      "--workspace",
      "@ariobarin/glossa",
      "--",
      "--reporter",
      "spec",
    ],
    stdin,
    timeoutMs: 120_000,
    waitMs: 0,
  };
  const state = applyHudEvent(connectedState(), {
    type: "activity",
    phase: "started",
    job,
  });
  const activity = state.activities[0]!;
  const output = renderHud(
    {
      ...state,
      view: "activity-detail",
      activitySelection: activity.requestId,
    },
    100,
    false,
    28,
    (activity.startedAt ?? Date.now()) + 18_000,
  );

  assert.match(output, /Glossa \/ Activity \/ Run Command/);
  assert.ok(output.indexOf("argv") < output.indexOf("OUTPUT"));
  assert.match(output, /started\s+\d\d:\d\d:\d\d/);
  assert.doesNotMatch(output, /\n\s+(?:ACTIVITY|CALL)\b|request\s+00000000|result\s+|state\s+|finished\s+/);
  assert.match(output, /\["npm", "run", "check", "--workspace", "@ariobarin\/glossa", "--",/);
  assert.match(output, /"--reporter",\s+"spec"\]/);
  assert.match(output, /stdin\s+18 B · content not retained in Activity/);
  assert.match(output, /timeoutMs\s+120000/);
  assert.match(output, /waitMs\s+0/);
  assert.match(output, /duration\s+18s/);
  assert.doesNotMatch(output, new RegExp(stdin));
});

test("devices page shows the device table without redundant overview copy", () => {
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
          lastSeen: "just now",
          status: "3 active workspaces",
          current: true,
        }],
      },
    },
    80,
    false,
    22,
  );

  assert.match(output.split("\n")[0]!, /Glossa \/ Devices\s+Connected/);
  assert.match(output, /Device\s+Workspaces\s+Platform\s+Last seen/);
  assert.match(
    output,
    /Laptop · this device\s+3 active workspaces\s+win32-x64\s+just now/,
  );
  assert.doesNotMatch(output, /OVERVIEW|PAIRED|Active workspaces\n|Devices\n|revoked/i);
});

test("devices use a compact readable row in narrow terminals", () => {
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
          lastSeen: "just now",
          status: "1 active workspace",
        }],
      },
    },
    58,
    false,
    22,
  );

  assert.match(
    output,
    /›\s+Laptop · 1 active workspace · win32-x64 · just now/,
  );
  assert.doesNotMatch(output, /Device\s+Workers\s+Platform\s+Last seen/);
});

test("devices view scrolls to keep the selected device visible", () => {
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
  ];

  for (const view of views) {
    const lines = renderHud(view, 28, false, 12).split("\n");
    assert.equal(lines.length, 12);
    assert.ok(lines.every((line) => line.length <= 28));
    assert.match(lines.slice(-3).join("\n"), /Q Quit/);
  }
});

