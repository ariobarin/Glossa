import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  cancelCommandRequestSchema,
  commandOutputRangeResultSchema as workerCommandOutputRangeSchema,
  commandResultSchema as workerCommandOutputSchema,
  containsRestrictedAuthenticationData,
  deletePathRequestSchema,
  deletePathResultSchema as deletePathOutputSchema,
  editFileRequestSchema,
  editFileResultSchema as editFileOutputSchema,
  getCommandRequestSchema,
  listFilesResultSchema as listFilesOutputSchema,
  makeDirectoryResultSchema as makeDirectoryOutputSchema,
  MAX_STRUCTURED_READ_TIMEOUT_MS,
  movePathResultSchema as movePathOutputSchema,
  listFilesRequestSchema,
  makeDirectoryRequestSchema,
  movePathRequestSchema,
  readCommandOutputRequestSchema,
  readFileRangeRequestSchema,
  readFileRangeResultSchema as readFileRangeOutputSchema,
  readFileRequestSchema,
  readFileResultSchema as readFileOutputSchema,
  runCommandRequestSchema,
  searchTextRequestSchema,
  searchTextResultSchema as searchTextOutputSchema,
  viewImageMetadataSchema as viewImageOutputSchema,
  viewImageRequestSchema,
  writeFileRequestSchema,
  writeFileResultSchema as writeFileOutputSchema,
  type WorkerJob,
  type WorkerResult,
} from "@glossa/protocol";
import {
  imageSuccess,
  restrictedDataResult,
  routedError,
  structuredResult,
  workerSuccess,
} from "./mcp-results.js";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_COPY } from "./mcp-copy.js";
import type { RelayConfig } from "./config.js";
import type { RouterState } from "./router-state.js";

export { MCP_SERVER_INSTRUCTIONS } from "./mcp-copy.js";

// Bump when a public tool name, schema, annotation, or result contract changes.
export const MCP_SERVER_VERSION = "3.2.0";

type RawRequestHandler = (request: unknown, extra: unknown) => unknown;
type LowLevelServerWithHandlers = {
  _requestHandlers: Map<string, RawRequestHandler>;
  setRequestHandler: McpServer["server"]["setRequestHandler"];
};
type ListedTool = Record<string, unknown> & {
  _meta?: Record<string, unknown>;
};

function promoteOpenAIToolSecuritySchemes(server: McpServer): void {
  const lowLevelServer = server.server as unknown as LowLevelServerWithHandlers;
  const originalListTools = lowLevelServer._requestHandlers.get("tools/list");
  if (!originalListTools) {
    throw new Error("The MCP SDK did not install its tools/list handler.");
  }

  lowLevelServer.setRequestHandler(
    ListToolsRequestSchema,
    async (request: unknown, extra: unknown) => {
      const result = await originalListTools(request, extra) as {
        tools: ListedTool[];
        [key: string]: unknown;
      };
      return {
        ...result,
        tools: result.tools.map((tool) => {
          const securitySchemes = tool._meta?.securitySchemes;
          return Array.isArray(securitySchemes)
            ? { ...tool, securitySchemes }
            : tool;
        }),
      } as never;
    },
  );
}

const workspaceIdFieldSchema = z
  .string()
  .uuid()
  .describe("Workspace ID from list_workspaces.");
const workspaceIdSchema = z.object({ workspaceId: workspaceIdFieldSchema }).strict();
const readFileInputSchema = readFileRequestSchema.extend(workspaceIdSchema.shape);
const viewImageInputSchema = viewImageRequestSchema.extend(workspaceIdSchema.shape);
const listFilesInputSchema = listFilesRequestSchema.extend(workspaceIdSchema.shape);
const searchTextInputSchema = searchTextRequestSchema.extend(workspaceIdSchema.shape);
const readFileRangeInputSchema = readFileRangeRequestSchema.extend(
  workspaceIdSchema.shape,
);
const writeFileInputSchema = writeFileRequestSchema.extend(workspaceIdSchema.shape);
const editFileInputSchema = editFileRequestSchema.safeExtend(workspaceIdSchema.shape);
const makeDirectoryInputSchema = makeDirectoryRequestSchema.extend(
  workspaceIdSchema.shape,
);
const deletePathInputSchema = deletePathRequestSchema.extend(workspaceIdSchema.shape);
const movePathInputSchema = movePathRequestSchema.extend(workspaceIdSchema.shape);
const runCommandSelectionSchema = z
  .union([
    z
      .object({
        argv: runCommandRequestSchema.shape.argv.unwrap().describe(
          runCommandRequestSchema.shape.argv.description ?? "Direct command arguments.",
        ),
      })
      .strict(),
    z
      .object({
        shellCommand: runCommandRequestSchema.shape.shellCommand.unwrap().describe(
          runCommandRequestSchema.shape.shellCommand.description ?? "Shell command text.",
        ),
      })
      .strict(),
  ])
  .describe("Direct executable or shell command.");
const runCommandInputSchema = z
  .object({
    workspaceId: workspaceIdFieldSchema,
    command: runCommandSelectionSchema,
    stdin: runCommandRequestSchema.shape.stdin,
    timeoutMs: runCommandRequestSchema.shape.timeoutMs,
    waitMs: runCommandRequestSchema.shape.waitMs,
  })
  .strict();
const getCommandInputSchema = getCommandRequestSchema.extend(workspaceIdSchema.shape);
const readCommandOutputInputSchema = readCommandOutputRequestSchema.extend(
  workspaceIdSchema.shape,
);
const cancelCommandInputSchema = cancelCommandRequestSchema.extend(workspaceIdSchema.shape);
const listWorkspacesOutputSchema = z
  .object({
    product: z
      .object({
        name: z.literal("Glossa").describe("Product name."),
        description: z
          .literal("File access and command execution in the user's connected workspaces.")
          .describe("Product description."),
        contractVersion: z
          .literal(MCP_SERVER_VERSION)
          .describe("Tool contract version."),
      })
      .strict()
      .describe("Glossa product information."),
    documentationUrl: z
      .string()
      .url()
      .describe("Setup documentation."),
    workspaces: z
      .array(
        z
          .object({
            workspaceId: z
              .string()
              .uuid()
              .describe("ID of this online workspace."),
            workspaceLabel: z
              .string()
              .optional()
              .describe("User-chosen workspace label."),
            accessProfile: z
              .enum(["read-only", "workspace", "system"])
              .describe("Workspace access profile."),
            permissions: z
              .object({
                readFiles: z.literal(true).describe("File reads enabled."),
                writeFiles: z.boolean().describe("Workspace file changes enabled."),
                runCommands: z.boolean().describe("Local commands enabled."),
              })
              .strict()
              .describe("Enabled operations."),
          })
          .strict(),
      )
      .describe("Online workspaces."),
    availability: z
      .enum(["online", "offline"])
      .describe("Whether any workspaces are online."),
    message: z
      .string()
      .describe("Connection status."),
  })
  .strict();
const logoutOutputSchema = z
  .object({
    logoutUrl: z
      .string()
      .url()
      .describe("Sign-out URL for the browser login provider."),
    instructions: z
      .string()
      .describe("Sign-out and account-switching steps."),
  })
  .strict();
const commandOutputSchema = workerCommandOutputSchema.extend({
  workspaceId: z
    .string()
    .uuid()
    .describe("Workspace ID for this command."),
});
const commandOutputRangeSchema = workerCommandOutputRangeSchema.extend({
  workspaceId: z
    .string()
    .uuid()
    .describe("Workspace ID for this command."),
});

const MANAGED_RELAY_ORIGIN = "https://mcp.glossa.sh";
const MANAGED_QUICKSTART_URL = "https://glossa.sh/docs/quickstart";
const SELF_HOSTING_DOCS_URL = "https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md";
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_FILE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const PRODUCT_CONTEXT = {
  name: "Glossa",
  description: "File access and command execution in the user's connected workspaces.",
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

function browserLogoutUrl(issuer: string): string {
  return new URL(
    "v2/logout",
    issuer.endsWith("/") ? issuer : `${issuer}/`,
  ).toString();
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

const COMMAND_STATUS_RELAY_HEADROOM_MS = 5_000;

function commandStatusWaitMs(
  config: RelayConfig,
  requestedWaitMs: number | undefined,
): number | undefined {
  if (requestedWaitMs === undefined) return undefined;
  const workerWaitBudget = Math.max(
    0,
    config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS - COMMAND_STATUS_RELAY_HEADROOM_MS,
  );
  return Math.min(requestedWaitMs, workerWaitBudget);
}

function registerTools(
  server: McpServer,
  config: RelayConfig,
  state: RouterState,
  accountId: string,
): void {
  async function dispatch(
    workspaceId: string,
    job: WorkerJob,
    convert: (result: WorkerResult) => CallToolResult,
  ): Promise<CallToolResult> {
    if (containsRestrictedAuthenticationData(job)) return restrictedDataResult();
    try {
      return convert(await state.enqueue(
        accountId, workspaceId, job, config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS,
      ));
    } catch (error) {
      return routedError(error);
    }
  }

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
    "list_workspaces",
    {
      ...MCP_TOOL_COPY.list_workspaces,
      inputSchema: z.object({}).strict(),
      outputSchema: listWorkspacesOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const workspaces = state.listDevices(accountId).map(({ deviceId, ...device }) => {
        const workspaceLabel = device.workspaceLabel &&
          !containsRestrictedAuthenticationData(device.workspaceLabel)
          ? device.workspaceLabel : undefined;
        return {
          workspaceId: deviceId,
          ...(workspaceLabel
            ? { workspaceLabel }
            : {}),
          accessProfile: device.accessProfile,
          permissions: device.permissions,
        };
      });
      const documentationUrl = officialDocumentationUrl(
        config.GLOSSA_PUBLIC_ORIGIN,
      );
      return structuredResult(
        workspaces.length > 0
          ? {
              product: PRODUCT_CONTEXT,
              documentationUrl,
              workspaces,
              availability: "online",
              message: "Glossa workspaces are online.",
            }
          : {
              product: PRODUCT_CONTEXT,
              documentationUrl,
              workspaces,
              availability: "offline",
              message: "No Glossa workspaces are online.",
            },
      );
    },
  );

  server.registerTool(
    "get_logout_instructions",
    {
      ...MCP_TOOL_COPY.get_logout_instructions,
      inputSchema: z.object({}).strict(),
      outputSchema: logoutOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const logoutUrl = browserLogoutUrl(config.GLOSSA_AUTH0_ISSUER);
      return structuredResult({
        logoutUrl,
        instructions: "Sign out on the Glossa control panel. To change a computer's account, stop Glossa, run `glossa unpair`, then restart and pair with the new account. Reconnect the Glossa app in ChatGPT to change its account.",
      });
    },
  );

  server.registerTool(
    "read_file",
    {
      ...MCP_TOOL_COPY.read_file,
      inputSchema: readFileInputSchema,
      outputSchema: readFileOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "read_file",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, readFileOutputSchema),
    ),
  );

  server.registerTool(
    "view_image",
    {
      ...MCP_TOOL_COPY.view_image,
      inputSchema: viewImageInputSchema,
      outputSchema: viewImageOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "view_image",
        requestId: randomUUID(),
        ...input,
      },
      imageSuccess,
    ),
  );

  server.registerTool(
    "list_files",
    {
      ...MCP_TOOL_COPY.list_files,
      inputSchema: listFilesInputSchema,
      outputSchema: listFilesOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, cursor, ...input }) => dispatch(
      workspaceId,
      {
        type: "list_files",
        requestId: randomUUID(),
        ...input,
        ...(path ? { path } : {}),
        ...(cursor ? { cursor } : {}),
        timeoutMs: structuredReadTimeoutMs(config),
      },
      (result) => workerSuccess(result, listFilesOutputSchema),
    ),
  );

  server.registerTool(
    "search_text",
    {
      ...MCP_TOOL_COPY.search_text,
      inputSchema: searchTextInputSchema,
      outputSchema: searchTextOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, ...input }) => dispatch(
      workspaceId,
      {
        type: "search_text",
        requestId: randomUUID(),
        ...input,
        ...(path ? { path } : {}),
        timeoutMs: structuredReadTimeoutMs(config),
      },
      (result) => workerSuccess(result, searchTextOutputSchema),
    ),
  );

  server.registerTool(
    "read_file_range",
    {
      ...MCP_TOOL_COPY.read_file_range,
      inputSchema: readFileRangeInputSchema,
      outputSchema: readFileRangeOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "read_file_range",
        requestId: randomUUID(),
        ...input,
        timeoutMs: structuredReadTimeoutMs(config),
      },
      (result) => workerSuccess(result, readFileRangeOutputSchema),
    ),
  );

  server.registerTool(
    "write_file",
    {
      ...MCP_TOOL_COPY.write_file,
      inputSchema: writeFileInputSchema,
      outputSchema: writeFileOutputSchema,
      _meta: toolMetadata,
      annotations: DESTRUCTIVE_FILE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "write_file",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, writeFileOutputSchema),
    ),
  );

  server.registerTool(
    "edit_file",
    {
      ...MCP_TOOL_COPY.edit_file,
      inputSchema: editFileInputSchema,
      outputSchema: editFileOutputSchema,
      _meta: toolMetadata,
      annotations: DESTRUCTIVE_FILE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "edit_file",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, editFileOutputSchema),
    ),
  );

  server.registerTool(
    "make_directory",
    {
      ...MCP_TOOL_COPY.make_directory,
      inputSchema: makeDirectoryInputSchema,
      outputSchema: makeDirectoryOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "make_directory",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, makeDirectoryOutputSchema),
    ),
  );

  server.registerTool(
    "delete_path",
    {
      ...MCP_TOOL_COPY.delete_path,
      inputSchema: deletePathInputSchema,
      outputSchema: deletePathOutputSchema,
      _meta: toolMetadata,
      annotations: DESTRUCTIVE_FILE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "delete_path",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, deletePathOutputSchema),
    ),
  );

  server.registerTool(
    "move_path",
    {
      ...MCP_TOOL_COPY.move_path,
      inputSchema: movePathInputSchema,
      outputSchema: movePathOutputSchema,
      _meta: toolMetadata,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "move_path",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, movePathOutputSchema),
    ),
  );

  server.registerTool(
    "run_command",
    {
      ...MCP_TOOL_COPY.run_command,
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
    async ({ workspaceId, command, ...input }) => dispatch(
      workspaceId,
      {
        type: "run_command",
        requestId: randomUUID(),
        ...input,
        ...command,
      },
      (result) => workerSuccess(result, workerCommandOutputSchema, workspaceId),
    ),
  );

  server.registerTool(
    "get_command",
    {
      ...MCP_TOOL_COPY.get_command,
      inputSchema: getCommandInputSchema,
      outputSchema: commandOutputSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, waitMs, ...input }) => dispatch(
      workspaceId,
      {
        type: "get_command",
        requestId: randomUUID(),
        ...input,
        ...(waitMs === undefined ? {} : { waitMs: commandStatusWaitMs(config, waitMs) }),
      },
      (result) => workerSuccess(result, workerCommandOutputSchema, workspaceId),
    ),
  );

  server.registerTool(
    "read_command_output",
    {
      ...MCP_TOOL_COPY.read_command_output,
      inputSchema: readCommandOutputInputSchema,
      outputSchema: commandOutputRangeSchema,
      _meta: toolMetadata,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "read_command_output",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, workerCommandOutputRangeSchema, workspaceId),
    ),
  );

  server.registerTool(
    "cancel_command",
    {
      ...MCP_TOOL_COPY.cancel_command,
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
    async ({ workspaceId, ...input }) => dispatch(
      workspaceId,
      {
        type: "cancel_command",
        requestId: randomUUID(),
        ...input,
      },
      (result) => workerSuccess(result, workerCommandOutputSchema, workspaceId),
    ),
  );

}

export function createMcpServer(
  config: RelayConfig,
  state: RouterState,
  accountId: string,
): McpServer {
  const server = new McpServer(
    {
      name: "glossa",
      version: MCP_SERVER_VERSION,
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerTools(server, config, state, accountId);
  // @modelcontextprotocol/sdk v1 serializes OpenAI-compatible security schemes
  // only inside _meta. Promote that exact value onto the root tools/list entry
  // until the SDK exposes a public root-level securitySchemes registration API.
  promoteOpenAIToolSecuritySchemes(server);
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
