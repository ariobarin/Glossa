import { z } from "zod";
import {
  RESTRICTED_DATA_ERROR_CODE,
  RESTRICTED_DATA_ERROR_MESSAGE,
  stringContainsRestrictedAuthenticationData,
} from "./restricted-data.js";

export {
  containsRestrictedAuthenticationData,
  RESTRICTED_DATA_ERROR_CODE,
  RESTRICTED_DATA_ERROR_MESSAGE,
  stringContainsRestrictedAuthenticationData,
} from "./restricted-data.js";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_EDIT_DIFF_BYTES = 128 * 1024;
export const MAX_EDIT_OPERATIONS = 100;
export const MAX_COMMAND_OUTPUT_BYTES = 12 * 1024;
export const MAX_COMMAND_RETAINED_STREAM_BYTES = 1024 * 1024;
export const DEFAULT_COMMAND_OUTPUT_RANGE_BYTES = 32 * 1024;
export const MAX_COMMAND_OUTPUT_RANGE_BYTES = 64 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_COMMAND_FAST_WAIT_MS = 750;
export const MAX_COMMAND_FAST_WAIT_MS = 5_000;
export const MAX_COMMAND_STATUS_WAIT_MS = 15_000;
export const DEFAULT_WORKER_POLL_MS = 15_000;
export const MAX_WORKER_POLL_MS = 18_000;
export const MAX_LIST_FILES_RESULTS = 200;
export const MAX_SEARCH_TEXT_RESULTS = 100;
export const MAX_SEARCH_TEXT_SNIPPET_CHARS = 400;
export const MAX_READ_FILE_RANGE_LINES = 500;
export const MAX_READ_FILE_RANGE_BYTES = 64 * 1024;
export const MAX_STRUCTURED_READ_TIMEOUT_MS = 8_000;

export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Device name contains control characters")
  .refine((value) => !stringContainsRestrictedAuthenticationData(value), {
    message: "Device name appears to contain restricted authentication data.",
  });

export const workspaceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[^\u0000-\u001f\u007f]+$/,
    "Workspace label contains control characters",
  )
  .refine((value) => !stringContainsRestrictedAuthenticationData(value), {
    message: "Workspace label appears to contain restricted authentication data.",
  });

export const workerAccessProfileSchema = z.enum([
  "read-only",
  "workspace",
  "system",
]);

export type WorkerAccessProfile = z.infer<typeof workerAccessProfileSchema>;

export const DEFAULT_WORKER_ACCESS_PROFILE: WorkerAccessProfile = "workspace";

export interface WorkerPermissions {
  readFiles: true;
  writeFiles: boolean;
  runCommands: boolean;
}

export function workerPermissions(
  accessProfile: WorkerAccessProfile,
): WorkerPermissions {
  switch (accessProfile) {
    case "read-only":
      return { readFiles: true, writeFiles: false, runCommands: false };
    case "workspace":
      return { readFiles: true, writeFiles: true, runCommands: false };
    case "system":
      return { readFiles: true, writeFiles: true, runCommands: true };
  }
}

export const relativePathSchema = z
  .string()
  .max(4096)
  .describe(
    "Path relative to the exposed workspace root. Absolute paths and parent traversal are rejected.",
  );
const boundedTextSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES);

export const readFileRequestSchema = z.object({
  path: relativePathSchema,
}).strict();

export const readFileJobSchema = readFileRequestSchema.extend({
  type: z.literal("read_file"),
  requestId: z.string().uuid(),
});

export const viewImageRequestSchema = z.object({
  path: relativePathSchema,
}).strict();

export const viewImageJobSchema = viewImageRequestSchema.extend({
  type: z.literal("view_image"),
  requestId: z.string().uuid(),
});

const structuredReadTimeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_STRUCTURED_READ_TIMEOUT_MS);

const listFilesCursorSchema = z
  .string()
  .max(4096)
  .describe("Opaque cursor returned by an earlier list_files result.");

export const listFilesRequestSchema = z.object({
  path: relativePathSchema
    .optional()
    .describe("Directory relative to the exposed root. Defaults to the root."),
  recursive: z
    .boolean()
    .optional()
    .describe("Whether to include descendants. Defaults to false."),
  cursor: listFilesCursorSchema.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_FILES_RESULTS)
    .optional()
    .describe("Maximum entries to return, from 1 through 200. Defaults to 100."),
}).strict();

export const listFilesJobSchema = listFilesRequestSchema.extend({
  type: z.literal("list_files"),
  requestId: z.string().uuid(),
  timeoutMs: structuredReadTimeoutSchema,
});

const searchGlobSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n\u0000]/.test(value), "Search glob must fit on one line")
  .describe("Root-relative glob pattern using forward slashes, for example src/**/*.ts.");

export const searchTextRequestSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) => !/[\r\n\u0000]/.test(value),
      "Search text must fit on one line",
    )
    .describe("Single-line UTF-8 search expression. Interpreted literally by default or as a JavaScript regular expression when matchMode is regex."),
  path: relativePathSchema
    .optional()
    .describe("File or directory relative to the exposed root. Defaults to the root."),
  matchMode: z
    .enum(["literal", "regex"])
    .optional()
    .describe("How to interpret query. Defaults to literal; regex uses JavaScript regular-expression syntax."),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Whether matching is case-sensitive. Defaults to false."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_TEXT_RESULTS)
    .optional()
    .describe("Maximum matching lines to return, from 1 through 100. Defaults to 50."),
  extensions: z
    .array(
      z.string().regex(/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/).describe(
        "Filename suffix including the leading dot, such as .ts or .d.ts.",
      ),
    )
    .min(1)
    .max(20)
    .optional()
    .describe("Optional filename extensions to search."),
  includeGlobs: z
    .array(searchGlobSchema)
    .min(1)
    .max(20)
    .optional()
    .describe("Optional root-relative glob patterns. A file must match at least one include pattern before its contents are scanned."),
  excludeGlobs: z
    .array(searchGlobSchema)
    .min(1)
    .max(20)
    .optional()
    .describe("Optional root-relative glob patterns. Matching files are skipped before their contents are scanned."),
}).strict();

export const searchTextJobSchema = searchTextRequestSchema.extend({
  type: z.literal("search_text"),
  requestId: z.string().uuid(),
  timeoutMs: structuredReadTimeoutSchema,
});

export const readFileRangeRequestSchema = z.object({
  path: relativePathSchema,
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First one-based line to return. Defaults to 1."),
  lineCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_FILE_RANGE_LINES)
    .optional()
    .describe("Maximum complete lines to return, from 1 through 500. Defaults to 200."),
}).strict();

export const readFileRangeJobSchema = readFileRangeRequestSchema.extend({
  type: z.literal("read_file_range"),
  requestId: z.string().uuid(),
  timeoutMs: structuredReadTimeoutSchema,
});

export const writeFileRequestSchema = z.object({
  path: relativePathSchema,
  content: boundedTextSchema.describe(
    "Complete UTF-8 text content for the new file or replacement revision.",
  ),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      "Full-file SHA-256 returned by read_file or read_file_range. Omit only when creating a new path; when provided, write_file replaces exactly that existing revision and fails if it is missing or changed.",
    ),
}).strict();

export const writeFileJobSchema = writeFileRequestSchema.extend({
  type: z.literal("write_file"),
  requestId: z.string().uuid(),
});

const editOperationSchema = z
  .object({
    oldText: boundedTextSchema
      .min(1)
      .describe(
        "Exact non-empty text to replace. The edit is rejected when the text is absent or occurs more than once.",
      ),
    newText: boundedTextSchema.describe(
      "Replacement UTF-8 text. Use an empty string to delete the matched text.",
    ),
  })
  .strict();

export const editFileRequestSchema = z
  .object({
    path: relativePathSchema,
    edits: z
      .array(editOperationSchema)
      .min(1)
      .max(MAX_EDIT_OPERATIONS)
      .describe(
        "Exact replacements evaluated against the same original file. Overlapping replacements are rejected.",
      ),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        "Full-file SHA-256 returned by read_file or read_file_range. When provided, the edit fails if the file changed.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.edits.reduce(
      (sum, edit) =>
        sum +
        Buffer.byteLength(edit.oldText, "utf8") +
        Buffer.byteLength(edit.newText, "utf8"),
      0,
    );
    if (bytes > MAX_TEXT_BYTES * 2) {
      context.addIssue({
        code: "custom",
        message: "The combined edit text exceeds the request size limit.",
        input: value.edits,
      });
    }
  });

export const editFileJobSchema = editFileRequestSchema.safeExtend({
  type: z.literal("edit_file"),
  requestId: z.string().uuid(),
});

export const makeDirectoryRequestSchema = z.object({
  path: relativePathSchema,
  recursive: z
    .boolean()
    .optional()
    .describe("Whether to create missing parent directories. Defaults to false."),
}).strict();

export const makeDirectoryJobSchema = makeDirectoryRequestSchema.extend({
  type: z.literal("make_directory"),
  requestId: z.string().uuid(),
});

export const deletePathRequestSchema = z.object({
  path: relativePathSchema,
  recursive: z
    .boolean()
    .optional()
    .describe("Whether to delete a non-empty directory tree. Defaults to false."),
}).strict();

export const deletePathJobSchema = deletePathRequestSchema.extend({
  type: z.literal("delete_path"),
  requestId: z.string().uuid(),
});

export const movePathRequestSchema = z.object({
  source: relativePathSchema.describe("Existing file or directory to move."),
  destination: relativePathSchema.describe(
    "New path inside the exposed root. The destination must not already exist.",
  ),
}).strict();

export const movePathJobSchema = movePathRequestSchema.extend({
  type: z.literal("move_path"),
  requestId: z.string().uuid(),
});

function requireOneCommand(
  value: {
    argv?: string[] | undefined;
    shellCommand?: string | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  if ((value.argv ? 1 : 0) + (value.shellCommand ? 1 : 0) !== 1) {
    context.addIssue({
      code: "custom",
      message: "Exactly one of argv or shellCommand is required.",
      input: value,
    });
  }
}

export const runCommandRequestSchema = z
  .object({
    argv: z
      .array(z.string())
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Preferred for native executables such as git and node. Executes directly without shell startup or parsing. On Windows, use shellCommand with the explicit .cmd or .bat filename, for example npm.cmd test. Provide this or shellCommand, not both.",
      ),
    shellCommand: z
      .string()
      .max(64 * 1024)
      .optional()
      .describe(
        "Use when shell features are required, such as pipes, redirection, variable expansion, or multiple statements. Also use on Windows for command shims, naming the .cmd or .bat file explicitly, for example npm.cmd test. Glossa starts PowerShell on Windows and the user's shell on macOS and Linux. Provide this or argv, not both.",
      ),
    stdin: boundedTextSchema
      .optional()
      .describe("Optional UTF-8 text sent to the command standard input."),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMAND_TIMEOUT_MS)
      .default(DEFAULT_COMMAND_TIMEOUT_MS)
      .describe(
        "Maximum command runtime in milliseconds. Defaults to 900000 and cannot exceed 3600000.",
      ),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_COMMAND_FAST_WAIT_MS)
      .optional()
      .describe(
        "How long run_command waits for fast completion before returning a running command handle. Use 0 for commands expected to run longer than a few seconds. Use 1500 to 2000 for short checks expected to finish near one second. Defaults to 750 and cannot exceed 5000.",
      ),
  })
  .strict()
  .superRefine(requireOneCommand);

export const runCommandJobSchema = runCommandRequestSchema.safeExtend({
  type: z.literal("run_command"),
  requestId: z.string().uuid(),
});

export const getCommandRequestSchema = z.object({
  commandId: z
    .string()
    .uuid()
    .describe("Command identifier returned by run_command."),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_COMMAND_STATUS_WAIT_MS)
    .optional()
    .describe("Optional long-poll duration in milliseconds, from 0 through 15000."),
  afterSequence: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Sequence returned by an earlier command result. When current, wait for output or status to change.",
    ),
}).strict();

export const getCommandJobSchema = getCommandRequestSchema.extend({
  type: z.literal("get_command"),
  requestId: z.string().uuid(),
});

export const readCommandOutputRequestSchema = z.object({
  commandId: z
    .string()
    .uuid()
    .describe("Command identifier returned by run_command."),
  stream: z
    .enum(["stdout", "stderr"])
    .describe("Command output stream to read independently."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based retained byte offset. Defaults to 0."),
  maxBytes: z
    .number()
    .int()
    .min(4)
    .max(MAX_COMMAND_OUTPUT_RANGE_BYTES)
    .optional()
    .describe(
      "Maximum retained source bytes to inspect, from 4 through 65536. Defaults to 32768.",
    ),
}).strict();

export const readCommandOutputJobSchema = readCommandOutputRequestSchema.extend({
  type: z.literal("read_command_output"),
  requestId: z.string().uuid(),
});

export const cancelCommandRequestSchema = z.object({
  commandId: z
    .string()
    .uuid()
    .describe("Command identifier returned by run_command."),
}).strict();

export const cancelCommandJobSchema = cancelCommandRequestSchema.extend({
  type: z.literal("cancel_command"),
  requestId: z.string().uuid(),
});

export const workerJobSchema = z.discriminatedUnion("type", [
  readFileJobSchema,
  viewImageJobSchema,
  listFilesJobSchema,
  searchTextJobSchema,
  readFileRangeJobSchema,
  writeFileJobSchema,
  editFileJobSchema,
  makeDirectoryJobSchema,
  deletePathJobSchema,
  movePathJobSchema,
  runCommandJobSchema,
  getCommandJobSchema,
  readCommandOutputJobSchema,
  cancelCommandJobSchema,
]);

export type WorkerJob = z.infer<typeof workerJobSchema>;

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest of the file content.");

export const readFileResultSchema = z.object({
  content: z.string().describe("Complete UTF-8 file content."),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative().describe("UTF-8 byte length of content."),
}).strict();

export const imageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export const viewImageMetadataSchema = z.object({
  mimeType: imageMimeTypeSchema.describe("Validated image media type."),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative().max(MAX_IMAGE_BYTES).describe("Compressed image byte length."),
}).strict();
export const viewImageResultSchema = viewImageMetadataSchema.extend({
  data: z
    .string()
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .describe("Base64-encoded image bytes returned only for MCP image content."),
}).superRefine((value, context) => {
  if (Buffer.byteLength(value.data, "base64") !== value.bytes) {
    context.addIssue({
      code: "custom",
      message: "Image byte metadata does not match the encoded data.",
      input: value.data,
    });
  }
});

export const listFilesResultSchema = z.object({
  entries: z.array(z.object({
    path: z.string().max(4096).describe("Path relative to the exposed root."),
    type: z.enum(["file", "directory"]).describe("Filesystem entry type."),
    bytes: z.number().int().nonnegative().optional().describe("File size in bytes. Omitted for directories."),
  }).strict()).max(MAX_LIST_FILES_RESULTS).describe("Bounded entries in deterministic path order."),
  truncated: z.boolean().describe("Whether additional entries are available."),
  scannedEntries: z.number().int().nonnegative().describe("Filesystem entries examined during this request."),
  skippedLinks: z.number().int().nonnegative().describe("Symlink or junction entries omitted from the result."),
  nextCursor: z.string().max(4096).optional().describe("Pass unchanged as cursor to continue a prior list_files result."),
}).strict();

export const searchTextResultSchema = z.object({
  matches: z.array(z.object({
    path: z.string().max(4096).describe("Matching file relative to the exposed root."),
    line: z.number().int().positive().describe("One-based matching line number."),
    column: z.number().int().positive().describe("One-based column of the first match on the line."),
    text: z.string().max(MAX_SEARCH_TEXT_SNIPPET_CHARS).describe("Bounded matching line snippet."),
    lineTruncated: z.boolean().describe("Whether the matching line was shortened."),
  }).strict()).max(MAX_SEARCH_TEXT_RESULTS).describe("Matching lines in deterministic path and line order."),
  truncated: z.boolean().describe("Whether result or scan limits stopped the search."),
  scannedFiles: z.number().int().nonnegative().describe("UTF-8 files searched."),
  scannedBytes: z.number().int().nonnegative().describe("Total UTF-8 file bytes searched."),
  skippedFiles: z.number().int().nonnegative().describe("Oversized, non-text, or unavailable files skipped."),
  skippedLinks: z.number().int().nonnegative().describe("Symlink or junction entries skipped."),
}).strict();

export const readFileRangeResultSchema = z.object({
  content: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_READ_FILE_RANGE_BYTES,
  ).describe("Complete lines returned for the requested range."),
  startLine: z.number().int().positive().describe("One-based first requested line."),
  endLine: z.number().int().nonnegative().describe("One-based final returned line, or 0 for an empty file."),
  totalLines: z.number().int().nonnegative().describe("Total complete lines in the file."),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative().describe("Full UTF-8 file size in bytes."),
  contentBytes: z.number().int().nonnegative().describe("UTF-8 byte size of returned content."),
  nextLine: z.number().int().positive().optional().describe("Next one-based line when more file content remains."),
}).strict();

export const writeFileResultSchema = z.object({
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative().describe("UTF-8 byte length written."),
}).strict();
export const editFileResultSchema = writeFileResultSchema.extend({
  replacements: z.number().int().positive().describe("Number of exact replacements applied."),
  diff: z.string().describe("Unified diff of the affected lines after the edit."),
  diffTruncated: z.boolean().describe("Whether the returned diff exceeded its display limit."),
}).strict();
export const makeDirectoryResultSchema = z.object({
  created: z.boolean().describe("Whether a new directory was created. False when it already existed."),
}).strict();
export const deletePathResultSchema = z.object({
  deletedType: z.enum(["file", "directory"]).describe("Type of workspace path deleted."),
}).strict();
export const movePathResultSchema = z.object({
  movedType: z.enum(["file", "directory"]).describe("Type of workspace path moved."),
}).strict();

export const commandStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
]);
export const commandResultSchema = z.object({
  commandId: z.string().uuid().describe("Identifier for get_command, read_command_output, and cancel_command."),
  status: commandStatusSchema.describe("Current command lifecycle state."),
  sequence: z.number().int().nonnegative().optional().describe("Monotonic output and status revision for incremental get_command calls."),
  exitCode: z.number().int().nullable().optional().describe("Process exit code when available."),
  signal: z.string().nullable().optional().describe("Termination signal when available."),
  stdout: z.string().optional().describe("Captured standard output so far, including while the command is running."),
  stderr: z.string().optional().describe("Captured standard error so far, including while the command is running."),
  stdoutTruncated: z.boolean().optional().describe("Whether standard output exceeded its returned share of the bounded command-result budget. Truncated output preserves its beginning and tail; use read_command_output to inspect retained omitted bytes without rerunning the command."),
  stderrTruncated: z.boolean().optional().describe("Whether standard error exceeded its returned share of the bounded command-result budget. Truncated output preserves its beginning and tail; use read_command_output to inspect retained omitted bytes without rerunning the command."),
}).strip();
export const commandOutputRangeResultSchema = z.object({
  commandId: z.string().uuid().describe("Command whose retained output was read."),
  stream: z.enum(["stdout", "stderr"]).describe("Output stream read independently."),
  status: commandStatusSchema.describe("Current command lifecycle state."),
  offset: z.number().int().nonnegative().describe("Actual zero-based retained byte offset of content."),
  content: z.string().describe("Bounded UTF-8 rendering of retained command output."),
  nextOffset: z.number().int().nonnegative().optional().describe("Next retained byte offset when more of this stream is currently available."),
  retainedBytes: z.number().int().nonnegative().describe("Stream bytes retained transiently for range retrieval."),
  totalBytes: z.number().int().nonnegative().describe("Total stream bytes observed, including bytes beyond the retention cap."),
  retentionTruncated: z.boolean().describe("Whether the stream exceeded the transient retention cap."),
  complete: z.boolean().describe("Whether the command has reached a terminal state."),
}).strict();

export type ReadFileResult = z.infer<typeof readFileResultSchema>;
export type ViewImageMetadata = z.infer<typeof viewImageMetadataSchema>;
export type ViewImageResult = z.infer<typeof viewImageResultSchema>;
export type ListFilesResult = z.infer<typeof listFilesResultSchema>;
export type SearchTextResult = z.infer<typeof searchTextResultSchema>;
export type ReadFileRangeResult = z.infer<typeof readFileRangeResultSchema>;
export type WriteFileResult = z.infer<typeof writeFileResultSchema>;
export type EditFileResult = z.infer<typeof editFileResultSchema>;
export type MakeDirectoryResult = z.infer<typeof makeDirectoryResultSchema>;
export type DeletePathResult = z.infer<typeof deletePathResultSchema>;
export type MovePathResult = z.infer<typeof movePathResultSchema>;
export type CommandStatus = z.infer<typeof commandStatusSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CommandOutputRangeResult = z.infer<typeof commandOutputRangeResultSchema>;

export const WORKER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_path: "The requested path is invalid.",
  absolute_path: "Absolute paths are not allowed.",
  path_traversal: "Parent path traversal is not allowed.",
  path_not_found: "The requested path does not exist.",
  parent_not_found: "The destination directory does not exist.",
  path_exists: "The file already exists. Read it first and pass expectedSha256 to replace that revision.",
  path_escape: "The requested path escapes the exposed root.",
  linked_path: "Symlink and junction paths are not allowed.",
  not_directory: "The requested path is not a directory.",
  not_file: "The requested path is not a file.",
  file_too_large: "The request exceeds the text size limit.",
  file_changed: "The file changed while it was being read.",
  not_text: "The file is not valid UTF-8 text.",
  image_too_large: "The image exceeds the 4 MiB image limit.",
  unsupported_image: "Only PNG, JPEG, and WebP images are supported.",
  scan_limit: "The repository scan limit was reached. Narrow the requested path.",
  search_byte_limit: "The repository search byte limit was reached. Narrow the requested path.",
  line_out_of_range: "The requested line is outside the file.",
  line_too_large: "The requested line exceeds the ranged-read limit.",
  scan_timeout: "The structured repository operation exceeded its local deadline.",
  stale_revision: "The file revision has changed.",
  edit_not_found: "The edit target was not found.",
  edit_ambiguous: "The edit target occurs more than once.",
  edit_overlap: "The requested edits overlap.",
  unsafe_temporary_file: "The atomic write could not be completed safely.",
  destination_exists: "The destination already exists.",
  directory_not_empty: "The directory is not empty. Set recursive to true only when the user authorized deleting its contents.",
  root_operation_refused: "The exposed workspace root cannot be deleted or moved.",
  unsupported_path_type: "Only regular files and directories are supported by this operation.",
  invalid_destination: "A directory cannot be moved inside itself.",
  write_access_disabled: "This workspace does not allow file writes. Do not retry; ask the user to restart with workspace access only if their request requires changes.",
  command_access_disabled: "This workspace does not allow commands. Do not retry; ask the user to restart with system access only if their request requires a local command.",
  worker_protocol_unsupported: "This workspace is running an older Glossa worker that does not support this operation. Ask the user to update Glossa and restart the workspace, then retry.",
  command_busy: "Another command is already running in this workspace.",
  invalid_command: "The command request is invalid.",
  invalid_timeout: "The command timeout is invalid.",
  invalid_wait: "The command status wait is invalid.",
  invalid_sequence: "The command progress sequence is invalid.",
  invalid_output_stream: "The command output stream must be stdout or stderr.",
  invalid_output_offset: "The command output offset is invalid.",
  invalid_output_range: "The command output range is invalid.",
  output_offset_out_of_range: "The command output offset exceeds the retained stream length.",
  command_not_found: "The command was not found.",
  command_spawn_failed: "The command could not be started.",
  windows_command_shim: "Windows .cmd and .bat command shims must be run through shellCommand with the explicit shim filename.",
  worker_failure: "The local worker operation failed.",
  invalid_limit: "The requested result limit is invalid.",
  invalid_search: "The search text is invalid.",
  invalid_range: "The requested file range is invalid.",
  [RESTRICTED_DATA_ERROR_CODE]: RESTRICTED_DATA_ERROR_MESSAGE,
};

export const workerResultSchema = z.object({
  requestId: z.string().uuid(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type WorkerResult = z.infer<typeof workerResultSchema>;
