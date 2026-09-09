import {
  containsRestrictedAuthenticationData,
  type WorkerJob,
} from "@glossa/protocol";

export type ActivityCall =
  | { type: "read_file"; path: string }
  | { type: "view_image"; path: string }
  | {
      type: "list_files";
      path?: string;
      recursive?: boolean;
      cursor?: string;
      limit?: number;
      timeoutMs: number;
    }
  | {
      type: "search_text";
      query: string;
      path?: string;
      matchMode?: "literal" | "regex";
      caseSensitive?: boolean;
      maxResults?: number;
      extensions?: string[];
      includeGlobs?: string[];
      excludeGlobs?: string[];
      timeoutMs: number;
    }
  | {
      type: "read_file_range";
      path: string;
      startLine?: number;
      lineCount?: number;
      timeoutMs: number;
    }
  | { type: "write_file"; path: string; contentBytes: number; expectedSha256?: string }
  | {
      type: "edit_file";
      path: string;
      editCount: number;
      editBytes: number;
      expectedSha256?: string;
    }
  | { type: "make_directory"; path: string; recursive?: boolean }
  | { type: "delete_path"; path: string; recursive?: boolean }
  | { type: "move_path"; source: string; destination: string }
  | {
      type: "run_command";
      argv?: string[];
      shellCommand?: string;
      stdinBytes?: number;
      timeoutMs: number;
      waitMs?: number;
    }
  | { type: "get_command"; commandId: string; waitMs?: number; afterSequence?: number }
  | {
      type: "read_command_output";
      commandId: string;
      stream: "stdout" | "stderr";
      offset?: number;
      maxBytes?: number;
    }
  | { type: "cancel_command"; commandId: string };

export type ActivityEventJob = ActivityCall & { requestId: string };

function redactedActivityJob(job: WorkerJob): WorkerJob {
  switch (job.type) {
    case "read_file":
    case "view_image":
      return { ...job, path: "[restricted input blocked]" };
    case "list_files":
      return {
        ...job,
        path: "[restricted input blocked]",
        cursor: undefined,
      };
    case "search_text":
      return {
        ...job,
        query: "[restricted input blocked]",
        path: undefined,
        extensions: undefined,
        includeGlobs: undefined,
        excludeGlobs: undefined,
      };
    case "read_file_range":
      return { ...job, path: "[restricted input blocked]" };
    case "write_file":
      return {
        ...job,
        path: "[restricted input blocked]",
        content: "[restricted input blocked]",
      };
    case "edit_file":
      return {
        ...job,
        path: "[restricted input blocked]",
        edits: [{ oldText: "[restricted input blocked]", newText: "" }],
      };
    case "make_directory":
    case "delete_path":
      return { ...job, path: "[restricted input blocked]" };
    case "move_path":
      return {
        ...job,
        source: "[restricted input blocked]",
        destination: "[restricted input blocked]",
      };
    case "run_command":
      return {
        type: "run_command",
        requestId: job.requestId,
        argv: ["[restricted input blocked]"],
        timeoutMs: job.timeoutMs,
        ...(job.waitMs === undefined ? {} : { waitMs: job.waitMs }),
      };
    case "get_command":
    case "read_command_output":
    case "cancel_command":
      return job;
  }
}

export function activityCallFromJob(job: WorkerJob): ActivityCall {
  const visible = containsRestrictedAuthenticationData(job)
    ? redactedActivityJob(job)
    : job;
  switch (visible.type) {
    case "read_file":
    case "view_image":
      return { type: visible.type, path: visible.path };
    case "list_files":
      return {
        type: visible.type,
        ...(visible.path === undefined ? {} : { path: visible.path }),
        ...(visible.recursive === undefined ? {} : { recursive: visible.recursive }),
        ...(visible.cursor === undefined ? {} : { cursor: visible.cursor }),
        ...(visible.limit === undefined ? {} : { limit: visible.limit }),
        timeoutMs: visible.timeoutMs,
      };
    case "search_text":
      return {
        type: visible.type,
        query: visible.query,
        ...(visible.path === undefined ? {} : { path: visible.path }),
        ...(visible.matchMode === undefined ? {} : { matchMode: visible.matchMode }),
        ...(visible.caseSensitive === undefined ? {} : { caseSensitive: visible.caseSensitive }),
        ...(visible.maxResults === undefined ? {} : { maxResults: visible.maxResults }),
        ...(visible.extensions === undefined ? {} : { extensions: visible.extensions }),
        ...(visible.includeGlobs === undefined ? {} : { includeGlobs: visible.includeGlobs }),
        ...(visible.excludeGlobs === undefined ? {} : { excludeGlobs: visible.excludeGlobs }),
        timeoutMs: visible.timeoutMs,
      };
    case "read_file_range":
      return {
        type: visible.type,
        path: visible.path,
        ...(visible.startLine === undefined ? {} : { startLine: visible.startLine }),
        ...(visible.lineCount === undefined ? {} : { lineCount: visible.lineCount }),
        timeoutMs: visible.timeoutMs,
      };
    case "write_file":
      return {
        type: visible.type,
        path: visible.path,
        contentBytes: Buffer.byteLength(visible.content, "utf8"),
        ...(visible.expectedSha256 === undefined ? {} : { expectedSha256: visible.expectedSha256 }),
      };
    case "edit_file":
      return {
        type: visible.type,
        path: visible.path,
        editCount: visible.edits.length,
        editBytes: visible.edits.reduce(
          (total, edit) => total + Buffer.byteLength(edit.oldText, "utf8") + Buffer.byteLength(edit.newText, "utf8"),
          0,
        ),
        ...(visible.expectedSha256 === undefined ? {} : { expectedSha256: visible.expectedSha256 }),
      };
    case "make_directory":
    case "delete_path":
      return {
        type: visible.type,
        path: visible.path,
        ...(visible.recursive === undefined ? {} : { recursive: visible.recursive }),
      };
    case "move_path":
      return { type: visible.type, source: visible.source, destination: visible.destination };
    case "run_command":
      return {
        type: visible.type,
        ...(visible.argv === undefined ? {} : { argv: visible.argv }),
        ...(visible.shellCommand === undefined ? {} : { shellCommand: visible.shellCommand }),
        ...(visible.stdin === undefined ? {} : { stdinBytes: Buffer.byteLength(visible.stdin, "utf8") }),
        timeoutMs: visible.timeoutMs,
        ...(visible.waitMs === undefined ? {} : { waitMs: visible.waitMs }),
      };
    case "get_command":
      return {
        type: visible.type,
        commandId: visible.commandId,
        ...(visible.waitMs === undefined ? {} : { waitMs: visible.waitMs }),
        ...(visible.afterSequence === undefined ? {} : { afterSequence: visible.afterSequence }),
      };
    case "read_command_output":
      return {
        type: visible.type,
        commandId: visible.commandId,
        stream: visible.stream,
        ...(visible.offset === undefined ? {} : { offset: visible.offset }),
        ...(visible.maxBytes === undefined ? {} : { maxBytes: visible.maxBytes }),
      };
    case "cancel_command":
      return { type: visible.type, commandId: visible.commandId };
  }
}

export function activityEventJobFromJob(job: WorkerJob): ActivityEventJob {
  return { requestId: job.requestId, ...activityCallFromJob(job) };
}

export function activityCallFromEventJob(job: ActivityEventJob): ActivityCall {
  const { requestId: _requestId, ...call } = job;
  return call as ActivityCall;
}
