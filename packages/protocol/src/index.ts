import { z } from "zod";
import { stringContainsRestrictedAuthenticationData } from "./restricted-data.js";

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
export type WorkerJobType = WorkerJob["type"];

export type WorkerOperationPermission = "read" | "write" | "command";
export type WorkerOperationLane = "status" | "cancel" | "read" | "mutation";

export interface WorkerOperationMetadata {
  permission: WorkerOperationPermission;
  lane: WorkerOperationLane;
  scanRestrictedInput: boolean;
  scanRestrictedResult: boolean;
}

export const WORKER_OPERATIONS = {
  read_file: {
    permission: "read",
    lane: "read",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  view_image: {
    permission: "read",
    lane: "read",
    scanRestrictedInput: true,
    scanRestrictedResult: false,
  },
  list_files: {
    permission: "read",
    lane: "read",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  search_text: {
    permission: "read",
    lane: "read",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  read_file_range: {
    permission: "read",
    lane: "read",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  write_file: {
    permission: "write",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: false,
  },
  edit_file: {
    permission: "write",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  make_directory: {
    permission: "write",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: false,
  },
  delete_path: {
    permission: "write",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: false,
  },
  move_path: {
    permission: "write",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: false,
  },
  run_command: {
    permission: "command",
    lane: "mutation",
    scanRestrictedInput: true,
    scanRestrictedResult: true,
  },
  get_command: {
    permission: "command",
    lane: "status",
    scanRestrictedInput: false,
    scanRestrictedResult: true,
  },
  read_command_output: {
    permission: "command",
    lane: "status",
    scanRestrictedInput: false,
    scanRestrictedResult: true,
  },
  cancel_command: {
    permission: "command",
    lane: "cancel",
    scanRestrictedInput: false,
    scanRestrictedResult: true,
  },
} as const satisfies Record<WorkerJobType, WorkerOperationMetadata>;

export const WORKER_JOB_TYPES = Object.freeze(
  Object.keys(WORKER_OPERATIONS) as WorkerJobType[],
);

export function workerOperation(
  type: WorkerJobType,
): WorkerOperationMetadata {
  return WORKER_OPERATIONS[type];
}

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
