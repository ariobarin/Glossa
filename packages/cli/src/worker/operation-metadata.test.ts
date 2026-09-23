import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_JOB_TYPES,
  workerJobAuthority,
  workerJobHasTextualResult,
  workerJobLane,
  workerJobTypeSchema,
} from "@glossa/protocol";

test("preserves independently specified operation policy and scheduling", () => {
  const reads = ["read_file", "view_image", "list_files", "search_text", "read_file_range"];
  const writes = ["write_file", "edit_file", "make_directory", "delete_path", "move_path"];
  const status = ["get_command", "read_command_output"];
  const commands = [...status, "cancel_command", "run_command"];
  assert.deepEqual(WORKER_JOB_TYPES, [...status, "cancel_command", ...reads, ...writes, "run_command"]);

  for (const [authority, expected] of Object.entries({ read: reads, write: writes, command: commands })) {
    assert.deepEqual(
      WORKER_JOB_TYPES.filter((type) => workerJobAuthority(type) === authority).sort(),
      [...expected].sort(),
    );
  }
  for (const [lane, expected] of Object.entries({
    status, cancel: ["cancel_command"], read: reads, mutation: [...writes, "run_command"],
  })) {
    assert.deepEqual(
      WORKER_JOB_TYPES.filter((type) => workerJobLane(type) === lane).sort(),
      [...expected].sort(),
    );
  }
  assert.deepEqual(
    WORKER_JOB_TYPES.filter(workerJobHasTextualResult).sort(),
    ["read_file", "list_files", "search_text", "read_file_range", "edit_file", ...commands].sort(),
  );
  for (const type of WORKER_JOB_TYPES) assert.equal(workerJobTypeSchema.parse(type), type);
  assert.equal(workerJobTypeSchema.safeParse("unknown_operation").success, false);
});
