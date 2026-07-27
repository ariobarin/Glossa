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
  readFileRequestSchema,
  runCommandRequestSchema,
  writeFileRequestSchema,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import type { RelayConfig } from "./config.js";
import type { RouterState } from "./router-state.js";

const deviceIdSchema = z
  .object({
    deviceId: z
      .string()
      .uuid()
      .describe("Online worker identifier returned by list_devices."),
  })
  .strict();
const readFileInputSchema = readFileRequestSchema.extend(deviceIdSchema.shape);
const writeFileInputSchema = writeFileRequestSchema.extend(deviceIdSchema.shape);
const editFileInputSchema = editFileRequestSchema.safeExtend(deviceIdSchema.shape);
const runCommandInputSchema = runCommandRequestSchema.safeExtend(
  deviceIdSchema.shape,
);
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest of the UTF-8 file content.");
const listDevicesOutputSchema = z
  .object({
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
const commandOutputSchema = z
  .object({
    commandId: z
      .string()
      .uuid()
      .describe("Identifier for get_command and cancel_command."),
    status: z
      .enum(["running", "succeeded", "failed", "canceled", "timed_out"])
      .describe("Current command lifecycle state."),
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
      .describe("Captured standard output after completion."),
    stderr: z
      .string()
      .optional()
      .describe("Captured standard error after completion."),
    stdoutTruncated: z
      .boolean()
      .optional()
      .describe("Whether standard output exceeded the shared command-output capture limit. Use a narrower command to retrieve omitted output."),
    stderrTruncated: z
      .boolean()
      .optional()
      .describe("Whether standard error exceeded the shared command-output capture limit. Use a narrower command to retrieve omitted output."),
  })
  .strip();

export const MCP_SERVER_VERSION = "0.1.0-beta.5";

const MANAGED_RELAY_ORIGIN = "https://mcp.glossa.sh";
const MANAGED_QUICKSTART_URL = "https://glossa.sh/docs/quickstart";
const SELF_HOSTING_DOCS_URL = "https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md";

function recoveryDocumentationUrl(publicOrigin: string): string {
  return new URL(publicOrigin).origin === MANAGED_RELAY_ORIGIN
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
  stale_revision: "The file revision has changed.",
  edit_not_found: "The edit target was not found.",
  edit_ambiguous: "The edit target occurs more than once.",
  edit_overlap: "The requested edits overlap.",
  command_busy: "Another command is already running on this device.",
  invalid_command: "The command request is invalid.",
  invalid_timeout: "The command timeout is invalid.",
  invalid_wait: "The command status wait is invalid.",
  command_not_found: "The command was not found.",
  command_spawn_failed: "The command could not be started.",
  worker_failure: "The local worker operation failed.",
};

function structuredResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function offlineWorkspaceMessage(config: RelayConfig): string {
  const guidance = "No Glossa workspaces are online. Glossa is the local bridge between ChatGPT and one explicitly exposed workspace. Ask the user to start or reconnect the local Glossa worker in the workspace they want to expose, wait until it appears here, then retry.";
  return `${guidance} See ${recoveryDocumentationUrl(config.GLOSSA_PUBLIC_ORIGIN)} for the official setup and reconnect steps.`;
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
      description: "Call this first to obtain the deviceId for every online Glossa workspace. If none are online, use availability and message to explain Glossa and guide the user to start or reconnect the local worker before retrying. One computer may expose several workspaces at once.",
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
      return structuredResult(
        devices.length > 0
          ? {
              devices,
              availability: "online",
              message: "Glossa workspaces are available.",
            }
          : {
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
      description: "Use when the user asks to sign out of Glossa or switch Google accounts. Tell the user to press l and confirm in the Glossa terminal or run glossa logout, stop any other Glossa sessions, and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. The returned logoutUrl is a fallback if the CLI does not open a browser. This tool returns instructions only and does not revoke credentials or change server state.",
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
        instructions: `In the Glossa terminal, press l and confirm, or run glossa logout. Stop any other Glossa sessions with q or Ctrl+C. If the CLI does not open a browser, open ${logoutUrl}. Then disconnect and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. Choose the same intended Google account for both authorizations.`,
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
      description: "Use when the task requires a shell command, tests, builds, version control, or multi-file work. Starts a bounded process with the full authority, inherited environment, and network access of the worker account. It waits briefly for fast completion and returns output immediately; longer commands return a handle for get_command. The command may modify local or external systems.",
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
    async ({ deviceId, argv, shellCommand, stdin, timeoutMs, waitMs }) => {
      const job: WorkerJob = {
        type: "run_command",
        requestId: randomUUID(),
        ...(argv ? { argv } : {}),
        ...(shellCommand ? { shellCommand } : {}),
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
        if (!result.ok) return workerError(result);
        const parsed = commandOutputSchema.safeParse(result.value);
        if (!parsed.success) {
          return errorResult(
            "invalid_worker_result",
            "The worker returned an invalid result.",
          );
        }
        state.rememberCommand(accountId, deviceId, parsed.data.commandId);
        return structuredResult(parsed.data);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "get_command",
    {
      title: "Get Command",
      description: "Use after run_command to read current status or completed output. Set waitMs to wait up to 15 seconds when the command is still running.",
      inputSchema: getCommandRequestSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ commandId, waitMs }) => {
      const deviceId = state.workerForCommand(accountId, commandId);
      if (!deviceId) {
        return errorResult("command_not_found", "The command was not found.");
      }
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "get_command",
          requestId: randomUUID(),
          commandId,
          ...(waitMs === undefined ? {} : { waitMs }),
        });
        return workerSuccess(result, commandOutputSchema);
      } catch (error) {
        return routedError(error);
      }
    },
  );

  server.registerTool(
    "cancel_command",
    {
      title: "Cancel Command",
      description: "Use only to stop a command started by run_command. Terminates its process tree but does not revert effects already caused.",
      inputSchema: cancelCommandRequestSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ commandId }) => {
      const deviceId = state.workerForCommand(accountId, commandId);
      if (!deviceId) {
        return errorResult("command_not_found", "The command was not found.");
      }
      try {
        const result = await executeJob(state, config, accountId, deviceId, {
          type: "cancel_command",
          requestId: randomUUID(),
          commandId,
        });
        return workerSuccess(result, commandOutputSchema);
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
