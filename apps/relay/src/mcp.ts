import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  cancelCommandRequestSchema,
  editFileRequestSchema,
  getCommandRequestSchema,
  MAX_LIST_FILES_RESULTS,
  MAX_READ_FILE_RANGE_BYTES,
  MAX_SEARCH_TEXT_RESULTS,
  MAX_SEARCH_TEXT_SNIPPET_CHARS,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  listFilesRequestSchema,
  readFileRangeRequestSchema,
  readFileRequestSchema,
  runCommandRequestSchema,
  searchTextRequestSchema,
  writeFileRequestSchema,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import type { RelayConfig } from "./config.js";
import type { RouterState } from "./router-state.js";

// Bump whenever a public tool name, schema, annotation, or result contract changes.
export const MCP_SERVER_VERSION = "0.1.0-beta.14";

const deviceIdFieldSchema = z
  .string()
  .uuid()
  .describe("Online worker identifier returned by list_devices.");
const deviceIdSchema = z.object({ deviceId: deviceIdFieldSchema }).strict();
const optionalCommandDeviceIdSchema = z
  .object({
    deviceId: deviceIdFieldSchema
      .optional()
      .describe(
        "Online worker identifier returned by run_command. Pass it when available; omission is supported only for compatibility with clients that cached the earlier command schema.",
      ),
  })
  .strict();
const readFileInputSchema = readFileRequestSchema.extend(deviceIdSchema.shape);
const listFilesInputSchema = listFilesRequestSchema.extend(deviceIdSchema.shape);
const searchTextInputSchema = searchTextRequestSchema.extend(deviceIdSchema.shape);
const readFileRangeInputSchema = readFileRangeRequestSchema.extend(
  deviceIdSchema.shape,
);
const writeFileInputSchema = writeFileRequestSchema.extend(deviceIdSchema.shape);
const editFileInputSchema = editFileRequestSchema.safeExtend(deviceIdSchema.shape);
const runCommandInputSchema = runCommandRequestSchema.safeExtend(
  deviceIdSchema.shape,
);
const getCommandInputSchema = getCommandRequestSchema.extend(
  optionalCommandDeviceIdSchema.shape,
);
const cancelCommandInputSchema = cancelCommandRequestSchema.extend(
  optionalCommandDeviceIdSchema.shape,
);
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest of the UTF-8 file content.");
const listDevicesOutputSchema = z
  .object({
    product: z
      .object({
        name: z.literal("Glossa").describe("Product name."),
        description: z
          .literal("The local bridge between ChatGPT and one explicitly exposed workspace.")
          .describe("Concise product identity for agent context."),
        contractVersion: z
          .literal(MCP_SERVER_VERSION)
          .describe("Public MCP tool-contract version advertised during initialization."),
      })
      .strict()
      .describe("Stable Glossa product identity."),
    documentationUrl: z
      .string()
      .url()
      .describe("Official setup and reconnect documentation for this relay deployment."),
    devices: z
      .array(
        z
          .object({
            deviceId: z
              .string()
              .uuid()
              .describe("Identifier to pass to workspace tools."),
            name: z.string().describe("Name of the computer running this worker."),
            path: z.literal(".").describe("The single exposed workspace root."),
            workspaceLabel: z
              .string()
              .optional()
              .describe("Optional user-chosen label for distinguishing online workspaces."),
          })
          .strict(),
      )
      .describe("Online workers available to the authenticated account."),
    availability: z
      .enum(["online", "offline"])
      .describe("Whether one or more Glossa workspaces are online."),
    message: z
      .string()
      .describe("Agent-facing availability guidance with a safe reconnect next step and no local workspace details."),
  })
  .strict();
const logoutOutputSchema = z
  .object({
    logoutUrl: z
      .string()
      .url()
      .describe("Browser URL the user must open to clear the Glossa login session."),
    instructions: z
      .string()
      .describe("Account-switching instructions to present to the user."),
  })
  .strict();
const readFileOutputSchema = z
  .object({
    content: z.string().describe("Complete UTF-8 file content."),
    sha256: sha256Schema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("UTF-8 byte length of content."),
  })
  .strict();
const listFilesOutputSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(4096)
              .describe("Path relative to the exposed root."),
            type: z
              .enum(["file", "directory"])
              .describe("Filesystem entry type."),
            bytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("File size in bytes. Omitted for directories."),
          })
          .strict(),
      )
      .max(MAX_LIST_FILES_RESULTS)
      .describe("Bounded entries in deterministic path order."),
    truncated: z
      .boolean()
      .describe("Whether additional entries are available."),
    scannedEntries: z
      .number()
      .int()
      .nonnegative()
      .describe("Filesystem entries examined during this request."),
    skippedLinks: z
      .number()
      .int()
      .nonnegative()
      .describe("Symlink or junction entries omitted from the result."),
    nextCursor: z
      .string()
      .max(4096)
      .optional()
      .describe("Pass unchanged as cursor to continue a prior list_files result."),
  })
  .strict();

const searchTextOutputSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(4096)
              .describe("Matching file relative to the exposed root."),
            line: z
              .number()
              .int()
              .positive()
              .describe("One-based matching line number."),
            column: z
              .number()
              .int()
              .positive()
              .describe("One-based column of the first match on the line."),
            text: z
              .string()
              .max(MAX_SEARCH_TEXT_SNIPPET_CHARS)
              .describe("Bounded matching line snippet."),
            lineTruncated: z
              .boolean()
              .describe("Whether the matching line was shortened."),
          })
          .strict(),
      )
      .max(MAX_SEARCH_TEXT_RESULTS)
      .describe("Matching lines in deterministic path and line order."),
    truncated: z
      .boolean()
      .describe("Whether result or scan limits stopped the search."),
    scannedFiles: z
      .number()
      .int()
      .nonnegative()
      .describe("UTF-8 files searched."),
    scannedBytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Total UTF-8 file bytes searched."),
    skippedFiles: z
      .number()
      .int()
      .nonnegative()
      .describe("Oversized, non-text, or unavailable files skipped."),
    skippedLinks: z
      .number()
      .int()
      .nonnegative()
      .describe("Symlink or junction entries skipped."),
  })
  .strict();

const readFileRangeOutputSchema = z
  .object({
    content: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_READ_FILE_RANGE_BYTES,
      )
      .describe("Complete lines returned for the requested range."),
    startLine: z
      .number()
      .int()
      .positive()
      .describe("One-based first requested line."),
    endLine: z
      .number()
      .int()
      .nonnegative()
      .describe("One-based final returned line, or 0 for an empty file."),
    totalLines: z
      .number()
      .int()
      .nonnegative()
      .describe("Total complete lines in the file."),
    sha256: sha256Schema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Full UTF-8 file size in bytes."),
    contentBytes: z
      .number()
      .int()
      .nonnegative()
      .describe("UTF-8 byte size of returned content."),
    nextLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Next one-based line when more file content remains."),
  })
  .strict();

const writeFileOutputSchema = z
  .object({
    sha256: sha256Schema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("UTF-8 byte length written."),
  })
  .strict();
const editFileOutputSchema = writeFileOutputSchema
  .extend({
    replacements: z
      .number()
      .int()
      .positive()
      .describe("Number of exact replacements applied."),
    diff: z
      .string()
      .describe("Unified diff of the affected lines after the edit."),
    diffTruncated: z
      .boolean()
      .describe("Whether the returned diff exceeded its display limit."),
  })
  .strict();
const workerCommandOutputSchema = z
  .object({
    commandId: z
      .string()
      .uuid()
      .describe("Identifier for get_command and cancel_command."),
    status: z
      .enum(["running", "succeeded", "failed", "canceled", "timed_out"])
      .describe("Current command lifecycle state."),
    sequence: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Monotonic output and status revision for incremental get_command calls."),
    exitCode: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Process exit code when available."),
    signal: z
      .string()
      .nullable()
      .optional()
      .describe("Termination signal when available."),
    stdout: z
      .string()
      .optional()
      .describe("Captured standard output so far, including while the command is running."),
    stderr: z
      .string()
      .optional()
      .describe("Captured standard error so far, including while the command is running."),
    stdoutTruncated: z
      .boolean()
      .optional()
      .describe("Whether standard output exceeded its returned share of the bounded command-result budget. Truncated output preserves its beginning and tail; use a narrower command to retrieve omitted detail."),
    stderrTruncated: z
      .boolean()
      .optional()
      .describe("Whether standard error exceeded its returned share of the bounded command-result budget. Truncated output preserves its beginning and tail; use a narrower command to retrieve omitted detail."),
  })
  .strip();
const commandOutputSchema = workerCommandOutputSchema.extend({
  deviceId: z
    .string()
    .uuid()
    .describe("Online worker identifier returned for restart-safe get_command and cancel_command follow-ups."),
});

const MANAGED_RELAY_ORIGIN = "https://mcp.glossa.sh";
const MANAGED_QUICKSTART_URL = "https://glossa.sh/docs/quickstart";
const SELF_HOSTING_DOCS_URL = "https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md";
const PRODUCT_CONTEXT = {
  name: "Glossa",
  description: "The local bridge between ChatGPT and one explicitly exposed workspace.",
  contractVersion: MCP_SERVER_VERSION,
} as const;

function isManagedRelay(publicOrigin: string): boolean {
  return new URL(publicOrigin).origin === MANAGED_RELAY_ORIGIN;
}

function officialDocumentationUrl(publicOrigin: string): string {
  return isManagedRelay(publicOrigin)
    ? MANAGED_QUICKSTART_URL
    : SELF_HOSTING_DOCS_URL;
}

const safeWorkerMessages: Record<string, string> = {
  path_not_found: "The requested path does not exist.",
  path_escape: "The requested path escapes the exposed root.",
  not_directory: "The requested path is not a directory.",
  not_file: "The requested path is not a file.",
  file_too_large: "The request exceeds the text size limit.",
  not_text: "The file is not valid UTF-8 text.",
  scan_limit: "The repository scan limit was reached. Narrow the requested path.",
  line_out_of_range: "The requested line is outside the file.",
  line_too_large: "The requested line exceeds the ranged-read limit.",
  scan_timeout: "The structured repository operation exceeded its local deadline.",
  stale_revision: "The file revision has changed.",
  edit_not_found: "The edit target was not found.",
  edit_ambiguous: "The edit target occurs more than once.",
  edit_overlap: "The requested edits overlap.",
  command_busy: "Another command is already running on this device.",
  invalid_command: "The command request is invalid.",
  invalid_shell: "The requested command shell is unavailable on this worker.",
  invalid_timeout: "The command timeout is invalid.",
  invalid_wait: "The command status wait is invalid.",
  invalid_sequence: "The command progress sequence is invalid.",
  command_not_found: "The command was not found.",
  command_spawn_failed: "The command could not be started.",
  worker_failure: "The local worker operation failed.",
  invalid_limit: "The requested result limit is invalid.",
  invalid_search: "The search text is invalid.",
  invalid_range: "The requested file range is invalid.",
};

function structuredResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function offlineWorkspaceMessage(config: RelayConfig): string {
  const documentationUrl = officialDocumentationUrl(
    config.GLOSSA_PUBLIC_ORIGIN,
  );
  if (isManagedRelay(config.GLOSSA_PUBLIC_ORIGIN)) {
    return `No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run \`glossa\`. Keep that terminal open, wait for the workspace to appear, then retry. See ${documentationUrl} for setup help.`;
  }
  return `No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and start Glossa using the platform-specific worker command at ${documentationUrl}. Keep that terminal open, wait for the workspace to appear, then retry.`;
}

function browserLogoutUrl(issuer: string): string {
  return new URL(
    "v2/logout",
    issuer.endsWith("/") ? issuer : `${issuer}/`,
  ).toString();
}

function errorResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
    isError: true,
  };
}

function routedError(error: unknown) {
  const code = error instanceof Error ? error.message : "relay_failure";
  if (code === "device_offline") {
    return errorResult(code, "The device is offline.");
  }
  if (code === "job_timeout") {
    return errorResult(code, "The worker did not respond in time.");
  }
  return errorResult("relay_failure", "The relay operation failed.");
}

function workerError(result: WorkerResult) {
  const code = result.error?.code ?? "worker_failure";
  return errorResult(
    code,
    safeWorkerMessages[code] ?? "The local worker operation failed.",
  );
}

function workerSuccess<T extends z.ZodObject>(
  result: WorkerResult,
  schema: T,
) {
  if (!result.ok) return workerError(result);
  const parsed = schema.safeParse(result.value);
  if (!parsed.success) {
    return errorResult(
      "invalid_worker_result",
      "The worker returned an invalid result.",
    );
  }
  return structuredResult(parsed.data);
}

function commandSuccess(
  result: WorkerResult,
  deviceId: string,
  onSuccess?: (value: z.infer<typeof workerCommandOutputSchema>) => void,
) {
  if (!result.ok) return workerError(result);
  const parsed = workerCommandOutputSchema.safeParse(result.value);
  if (!parsed.success) {
    return errorResult(
      "invalid_worker_result",
      "The worker returned an invalid result.",
    );
  }
  onSuccess?.(parsed.data);
  return structuredResult({ deviceId, ...parsed.data });
}

function structuredReadError(
  state: RouterState,
  accountId: string,
  deviceId: string,
) {
  const online = state
    .listDevices(accountId)
    .some((device) => device.deviceId === deviceId);
  if (!online) return errorResult("device_offline", "The device is offline.");
  if (!state.supportsStructuredReads(accountId, deviceId)) {
    return errorResult(
      "worker_update_required",
      "Update and reconnect the Glossa worker before using structured repository tools.",
    );
  }
  return null;
}

function structuredReadTimeoutMs(config: RelayConfig): number {
  return Math.max(
    1,
    Math.min(
      MAX_STRUCTURED_READ_TIMEOUT_MS,
      Math.floor(config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS / 2),
    ),
  );
}

async function executeJob(
  state: RouterState,
  config: RelayConfig,
  accountId: string,
  deviceId: string,
  job: WorkerJob,
): Promise<WorkerResult> {
  return await state.enqueue(
    accountId,
    deviceId,
    job,
    config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS,
  );
}

function registerTools(
  server: McpServer,
  config: RelayConfig,
  state: RouterState,
  accountId: string,
): void {
  const toolMetadata = {
    securitySchemes: [
      {
        type: "oauth2",
        scopes: [config.GLOSSA_MCP_REQUIRED_SCOPE],
      },
    ],
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
  };

  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description: "Call this first to obtain the deviceId for every online Glossa workspace. If none are online, use message and documentationUrl to give the user the deployment-specific start instructions, then retry after the workspace appears. One computer may expose several workspaces at once.",
      inputSchema: z.object({}).strict(),
      outputSchema: listDevicesOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const devices = state.listDevices(accountId);
      const documentationUrl = officialDocumentationUrl(
        config.GLOSSA_PUBLIC_ORIGIN,
      );
      return structuredResult(
        devices.length > 0
          ? {
              product: PRODUCT_CONTEXT,
              documentationUrl,
              devices,
              availability: "online",
              message: "Glossa workspaces are available.",
            }
          : {
              product: PRODUCT_CONTEXT,
              documentationUrl,
              devices,
              availability: "offline",
              message: offlineWorkspaceMessage(config),
            },
      );
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Log Out of Glossa",
      description: "Use when the user asks to sign out of Glossa or switch Google accounts. Tell the user to run glossa logout, stop any other Glossa sessions, and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. The returned logoutUrl is a fallback if the CLI does not open a browser. This tool returns instructions only and does not revoke credentials or change server state.",
      inputSchema: z.object({}).strict(),
      outputSchema: logoutOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const logoutUrl = browserLogoutUrl(config.GLOSSA_AUTH0_ISSUER);
      return structuredResult({
        logoutUrl,
        instructions: `Run glossa logout. Stop any other Glossa sessions with Ctrl+C. If the CLI does not open a browser, open ${logoutUrl}. Then disconnect and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. Choose the same intended Google account for both authorizations.`,
      });
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Use after list_devices to read one known UTF-8 text file. Returns its full content and SHA-256 for a guarded write_file call.",
      inputSchema: readFileInputSchema,
      outputSchema: readFileOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, path }) => {
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "read_file",
          requestId: randomUUID(),
          path,
        });
        return workerSuccess(result, readFileOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description: "List bounded regular files and directories without following links. Use cursor pagination or a narrower path for large workspaces.",
      inputSchema: listFilesInputSchema,
      outputSchema: listFilesOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, path, recursive, cursor, limit }) => {
      const unavailable = structuredReadError(state, accountId, deviceId);
      if (unavailable) return unavailable;
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "list_files",
          requestId: randomUUID(),
          timeoutMs: structuredReadTimeoutMs(config),
          ...(path ? { path } : {}),
          ...(recursive === undefined ? {} : { recursive }),
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
        return workerSuccess(result, listFilesOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "search_text",
    {
      title: "Search Text",
      description: "Search literal text across bounded UTF-8 files without invoking a shell. Returns matching lines, paths, and scan statistics.",
      inputSchema: searchTextInputSchema,
      outputSchema: searchTextOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, query, path, caseSensitive, maxResults, extensions }) => {
      const unavailable = structuredReadError(state, accountId, deviceId);
      if (unavailable) return unavailable;
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "search_text",
          requestId: randomUUID(),
          timeoutMs: structuredReadTimeoutMs(config),
          query,
          ...(path ? { path } : {}),
          ...(caseSensitive === undefined ? {} : { caseSensitive }),
          ...(maxResults === undefined ? {} : { maxResults }),
          ...(extensions ? { extensions } : {}),
        });
        return workerSuccess(result, searchTextOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "read_file_range",
    {
      title: "Read File Range",
      description: "Read a bounded range of complete lines from one UTF-8 file. Use nextLine to continue through a large file while retaining its full-file SHA-256.",
      inputSchema: readFileRangeInputSchema,
      outputSchema: readFileRangeOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, path, startLine, lineCount }) => {
      const unavailable = structuredReadError(state, accountId, deviceId);
      if (unavailable) return unavailable;
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "read_file_range",
          requestId: randomUUID(),
          timeoutMs: structuredReadTimeoutMs(config),
          path,
          ...(startLine === undefined ? {} : { startLine }),
          ...(lineCount === undefined ? {} : { lineCount }),
        });
        return workerSuccess(result, readFileRangeOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Use to create or completely replace one UTF-8 text file inside the exposed root. Pass the SHA-256 from read_file when editing an existing file to reject stale overwrites.",
      inputSchema: writeFileInputSchema,
      outputSchema: writeFileOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ deviceId, path, content, expectedSha256 }) => {
      const job: WorkerJob = {
        type: "write_file",
        requestId: randomUUID(),
        path,
        content,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      };
      try {
        const result = await executeJob(
          state,
          config,
          accountId,
          deviceId,
          job,
        );
        return workerSuccess(result, writeFileOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Use after read_file to make one or more precise changes without replacing the entire file. Each oldText must occur exactly once in the original file, edits may not overlap, and expectedSha256 guards against concurrent changes. Returns the new hash and a unified diff.",
      inputSchema: editFileInputSchema,
      outputSchema: editFileOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ deviceId, path, edits, expectedSha256 }) => {
      const job: WorkerJob = {
        type: "edit_file",
        requestId: randomUUID(),
        path,
        edits,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      };
      try {
        const result = await executeJob(
          state,
          config,
          accountId,
          deviceId,
          job,
        );
        return workerSuccess(result, editFileOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description: "Use for tests, builds, version control, or multi-file work. Prefer argv for a native executable. Use shellCommand for pipes, redirection, variable expansion, multiple statements, and Windows command shims with an explicit .cmd or .bat filename such as npm.cmd. On Windows, set windowsShell to cmd for shim commands that do not require PowerShell syntax; PowerShell remains the default. Starts a bounded process with the full authority, inherited environment, and network access of the worker account. It waits briefly for fast completion and returns output immediately; longer commands return a handle for get_command. The command may modify local or external systems.",
      inputSchema: runCommandInputSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ deviceId, argv, shellCommand, windowsShell, stdin, timeoutMs, waitMs }) => {
      const job: WorkerJob = {
        type: "run_command",
        requestId: randomUUID(),
        ...(argv ? { argv } : {}),
        ...(shellCommand ? { shellCommand } : {}),
        ...(windowsShell ? { windowsShell } : {}),
        ...(stdin !== undefined ? { stdin } : {}),
        timeoutMs,
        ...(waitMs === undefined ? {} : { waitMs }),
      };
      try {
        const result = await executeJob(
          state,
          config,
          accountId,
          deviceId,
          job,
        );
        return commandSuccess(result, deviceId, (command) => {
          if (command.status === "running") {
            state.rememberCommand(accountId, deviceId, command.commandId);
          } else {
            state.forgetCommand(accountId, command.commandId);
          }
        });
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "get_command",
    {
      title: "Get Command",
      description: "Use after run_command to read status and captured output so far. Pass its deviceId and commandId when available. Clients with a cached earlier schema may omit deviceId while the relay still remembers that running command. Pass the returned sequence as afterSequence with waitMs to return when output or status changes, for up to 15 seconds.",
      inputSchema: getCommandInputSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, commandId, waitMs, afterSequence }) => {
      const routedDeviceId =
        deviceId ?? state.workerForCommand(accountId, commandId);
      if (!routedDeviceId) {
        return errorResult(
          "command_not_found",
          "The command route is unavailable. Start the command again and pass deviceId when the client supports it.",
        );
      }
      try {
        const result = await executeJob(
          state,
          config,
          accountId,
          routedDeviceId,
          {
            type: "get_command",
            requestId: randomUUID(),
            commandId,
            ...(waitMs === undefined ? {} : { waitMs }),
            ...(afterSequence === undefined ? {} : { afterSequence }),
          },
        );
        if (!result.ok && result.error?.code === "command_not_found") {
          state.forgetCommandForWorker(
            accountId,
            routedDeviceId,
            commandId,
          );
        }
        return commandSuccess(result, routedDeviceId, (command) => {
          if (command.status !== "running") {
            state.forgetCommand(accountId, command.commandId);
          }
        });
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "cancel_command",
    {
      title: "Cancel Command",
      description: "Use only to stop a command started by run_command. Pass its deviceId and commandId when available. Clients with a cached earlier schema may omit deviceId while the relay still remembers that running command. Terminates its process tree but does not revert effects already caused.",
      inputSchema: cancelCommandInputSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deviceId, commandId }) => {
      const routedDeviceId =
        deviceId ?? state.workerForCommand(accountId, commandId);
      if (!routedDeviceId) {
        return errorResult(
          "command_not_found",
          "The command route is unavailable. Start the command again and pass deviceId when the client supports it.",
        );
      }
      try {
        const result = await executeJob(
          state,
          config,
          accountId,
          routedDeviceId,
          {
            type: "cancel_command",
            requestId: randomUUID(),
            commandId,
          },
        );
        if (!result.ok && result.error?.code === "command_not_found") {
          state.forgetCommandForWorker(
            accountId,
            routedDeviceId,
            commandId,
          );
        }
        return commandSuccess(result, routedDeviceId, (command) => {
          if (command.status !== "running") {
            state.forgetCommand(accountId, command.commandId);
          }
        });
      } catch (error) {
        return routedError(error);
      }
    },
  );

}

export function createMcpServer(
  config: RelayConfig,
  state: RouterState,
  accountId: string,
): McpServer {
  const server = new McpServer({
    name: "glossa",
    version: MCP_SERVER_VERSION,
  });
  registerTools(server, config, state, accountId);
  return server;
}

export async function handleMcpRequest(
  request: Request,
  response: Response,
  config: RelayConfig,
  state: RouterState,
  accountId: string,
): Promise<void> {
  const server = createMcpServer(config, state, accountId);
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, request.body);
  } finally {
    await transport.close();
    await server.close();
  }
}
