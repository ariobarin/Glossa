import assert from "node:assert/strict";
import test from "node:test";

import {
  activityCallDetailFields,
  activityCallFromJob,
  formatActivityCall,
} from "./ui-hud-activity.js";

test("compact paths preserve identity-bearing components", () => {
  const compact = formatActivityCall(
    {
      type: "read_file",
      path: "packages/cli/src/components/activity/very/deep/ui-hud.tsx",
    },
    "compact",
    36,
  );

  assert.ok(compact.length <= 36);
  assert.match(compact, /^packages\//);
  assert.match(compact, /ui-hud\.tsx$/);
  assert.match(compact, /…/);

  const narrow = formatActivityCall(
    {
      type: "read_file",
      path: "packages/cli/src/components/activity/very/deep/ui-hud.tsx",
    },
    "compact",
    12,
  );
  assert.equal(narrow, "…/ui-hud.tsx");
});

test("command summaries preserve complete argv endpoints", () => {
  const call = activityCallFromJob({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000001",
    argv: [
      "npm",
      "run",
      "cli:hud-preview",
      "--",
      "--width",
      "90",
      "--screen",
      "activity",
    ],
    timeoutMs: 900_000,
  });

  const compact = formatActivityCall(call, "compact", 48);
  const detailed = formatActivityCall(call, "detailed", 62);

  assert.match(compact, /^npm run cli:hud-preview/);
  assert.match(compact, /--screen activity$/);
  assert.match(compact, /…/);
  assert.equal(Array.from(compact).filter((character) => character === "…").length, 1);
  assert.match(detailed, /^argv \["npm", "run",/);
  assert.match(detailed, /"--screen", "activity"\]$/);
  assert.match(detailed, /…/);
});

test("Activity calls retain safe metadata but not payload bodies", () => {
  const writeCall = activityCallFromJob({
    type: "write_file",
    requestId: "00000000-0000-4000-8000-000000000002",
    path: "src/config.ts",
    content: "sensitive file body",
    expectedSha256: "a".repeat(64),
  });
  const editCall = activityCallFromJob({
    type: "edit_file",
    requestId: "00000000-0000-4000-8000-000000000003",
    path: "src/config.ts",
    edits: [{ oldText: "private old text", newText: "private new text" }],
    expectedSha256: "b".repeat(64),
  });
  const commandCall = activityCallFromJob({
    type: "run_command",
    requestId: "00000000-0000-4000-8000-000000000004",
    argv: ["node", "script.js", "--target", "full-target.ts"],
    stdin: "private stdin body",
    timeoutMs: 30_000,
  });
  const restricted = `sk-proj-${"A".repeat(32)}`;
  const searchCall = activityCallFromJob({
    type: "search_text",
    requestId: "00000000-0000-4000-8000-000000000005",
    query: "needle",
    includeGlobs: [`src/${restricted}/**`],
    timeoutMs: 8_000,
  });

  const serialized = JSON.stringify([writeCall, editCall, commandCall, searchCall]);
  assert.doesNotMatch(serialized, /sensitive file body|private old text|private new text|private stdin body/);
  assert.match(serialized, /full-target\.ts/);
  assert.match(serialized, /contentBytes|editBytes|stdinBytes/);
  assert.doesNotMatch(serialized, new RegExp(restricted));
  assert.deepEqual(searchCall, {
    type: "search_text",
    query: "[restricted input blocked]",
    timeoutMs: 8_000,
  });

  const writeFields = activityCallDetailFields(writeCall);
  const editFields = activityCallDetailFields(editCall);
  const commandFields = activityCallDetailFields(commandCall);
  assert.match(JSON.stringify(writeFields), /content not retained in Activity/);
  assert.match(JSON.stringify(editFields), /text not retained in Activity/);
  assert.match(JSON.stringify(commandFields), /content not retained in Activity/);
  assert.match(JSON.stringify(commandFields), /full-target\.ts/);
});
