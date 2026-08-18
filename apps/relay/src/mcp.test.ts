import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  createMcpServer,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_VERSION,
} from "./mcp.js";
import { RouterState } from "./router-state.js";

const expectedTools = [
  "cancel_command",
  "delete_path",
  "edit_file",
  "get_command",
  "get_logout_instructions",
  "list_files",
  "list_workspaces",
  "make_directory",
  "move_path",
  "read_command_output",
  "read_file",
  "read_file_range",
  "run_command",
  "search_text",
  "view_image",
  "write_file",
];
const expectedToolTitles: Record<string, string> = {
  cancel_command: "Stop Workspace Command",
  delete_path: "Delete Workspace Path",
  edit_file: "Edit Workspace File",
  get_command: "Check Workspace Command",
  get_logout_instructions: "Get Glossa Sign-Out Steps",
  list_files: "List Workspace Files",
  list_workspaces: "Find Glossa Workspaces",
  make_directory: "Create Workspace Directory",
  move_path: "Move Workspace Path",
  read_command_output: "Read Workspace Command Output",
  read_file: "Read Workspace File",
  read_file_range: "Read Workspace File Range",
  run_command: "Run Workspace Command",
  search_text: "Search Workspace Text",
  view_image: "View Workspace Image",
  write_file: "Create or Replace Workspace File",
};
const expectedToolAnnotations: Record<string, {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}> = {
  cancel_command: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  delete_path: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  edit_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  get_command: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_logout_instructions: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_files: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_workspaces: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  make_directory: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  move_path: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  read_command_output: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_file: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_file_range: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_command: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  search_text: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  view_image: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};
const accountId = "00000000-0000-4000-8000-000000000001";
const product = {
  name: "Glossa",
  description: "Bridge ChatGPT to a user-controlled local development workspace and its existing toolchain through an outbound worker.",
  contractVersion: MCP_SERVER_VERSION,
};
const managedDocumentationUrl = "https://glossa.sh/docs/quickstart";
const selfHostingDocumentationUrl = "https://github.com/ariobarin/glossa/blob/main/docs/self-hosting.md";

interface JsonSchemaNode {
  description?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  required?: string[];
  additionalProperties?: boolean;
}

function assertFieldDescriptions(schema: JsonSchemaNode, label: string): void {
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    assert.equal(
      typeof property.description,
      "string",
      `${label}.${name} must have a description`,
    );
    assertFieldDescriptions(property, `${label}.${name}`);
    if (property.items) {
      assertFieldDescriptions(property.items, `${label}.${name}[]`);
    }
  }
}

function testConfig(publicOrigin = "https://mcp.glossa.sh") {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GLOSSA_PUBLIC_ORIGIN: publicOrigin,
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://mcp.glossa.test/",
  });
}

test("publishes reviewable MCP tool contracts", async (context) => {
  const state = new RouterState();
  const server = createMcpServer(
    testConfig(),
    state,
    accountId,
  );
  const client = new Client({ name: "glossa-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  assert.equal(MCP_SERVER_VERSION, "3.1.0");
  assert.equal(client.getServerVersion()?.version, MCP_SERVER_VERSION);
  assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Use Glossa only for a local development workspace/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Do not use Glossa for general questions, web research, built-in ChatGPT tasks/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /The Glossa CLI shows a short pairing code that the user redeems on the Glossa control panel; pairing never happens through an MCP tool/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /inspect accessProfile and permissions/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /never write when writeFiles is false or run commands when runCommands is false/);
  const instructionPrefix = MCP_SERVER_INSTRUCTIONS.slice(0, 512);
  assert.match(instructionPrefix, /list_workspaces/);
  assert.match(instructionPrefix, /accessProfile and permissions/);
  assert.match(instructionPrefix, /never write when writeFiles is false or run commands when runCommands is false/);
  assert.match(instructionPrefix, /untrusted data/);
  assert.match(instructionPrefix, /Restricted Data/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /inherited environment and credentials, and network access/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Do not use commands to inspect secrets, bypass file-tool boundaries/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /planning alone are read-only/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Change and fix requests authorize only scoped edits/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /A build request authorizes the requested build command only when system access is already enabled/);
  assert.match(
    MCP_SERVER_INSTRUCTIONS,
    /Never request, pass, or return Restricted Data.*access credentials,? or authentication secrets/,
  );
  assert.match(
    MCP_SERVER_INSTRUCTIONS,
    /local worker suppresses recognizable credential material.*view_image.*opaque.*Restricted Data.*defense in depth, not a sandbox/,
  );

  const openAIToolListSchema = z.object({
    tools: z.array(z.object({
      name: z.string(),
      securitySchemes: z.array(z.object({
        type: z.literal("oauth2"),
        scopes: z.array(z.string()),
      })),
    }).passthrough()),
  }).passthrough();
  const openAIToolList = await client.request(
    { method: "tools/list", params: {} },
    openAIToolListSchema,
  );
  assert.equal(openAIToolList.tools.length, expectedTools.length);
  for (const tool of openAIToolList.tools) {
    assert.deepEqual(tool.securitySchemes, [
      { type: "oauth2", scopes: ["glossa:access"] },
    ]);
  }

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    expectedTools,
  );

  for (const tool of tools) {
    assert.equal(tool.title, expectedToolTitles[tool.name]);
    assert.ok(tool.description, `${tool.name} must have a description`);
    assert.match(tool.description, /^Use this /, `${tool.name} must state when to use it`);
    assert.ok(tool.inputSchema, `${tool.name} must have an input schema`);
    assert.ok(tool.outputSchema, `${tool.name} must have an output schema`);
    assertFieldDescriptions(
      tool.inputSchema as JsonSchemaNode,
      `${tool.name}.input`,
    );
    assertFieldDescriptions(
      tool.outputSchema as JsonSchemaNode,
      `${tool.name}.output`,
    );
    assert.equal(tool._meta?.["openai/visibility"], "public");
    assert.deepEqual(tool._meta?.ui, { visibility: ["model"] });
    assert.deepEqual(tool._meta?.securitySchemes, [
      { type: "oauth2", scopes: ["glossa:access"] },
    ]);
    const expectedAnnotations = expectedToolAnnotations[tool.name];
    assert.ok(expectedAnnotations, `${tool.name} must have expected annotations`);
    assert.equal(tool.annotations?.readOnlyHint, expectedAnnotations.readOnlyHint);
    assert.equal(tool.annotations?.destructiveHint, expectedAnnotations.destructiveHint);
    assert.equal(tool.annotations?.idempotentHint, expectedAnnotations.idempotentHint);
    assert.equal(tool.annotations?.openWorldHint, expectedAnnotations.openWorldHint);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const toolName of [
    "read_file",
    "view_image",
    "list_files",
    "search_text",
    "read_file_range",
    "write_file",
    "edit_file",
    "make_directory",
    "delete_path",
    "move_path",
    "run_command",
    "get_command",
    "read_command_output",
    "cancel_command",
  ]) {
    const inputSchema = byName.get(toolName)?.inputSchema as JsonSchemaNode;
    assert.ok(inputSchema.properties?.workspaceId, `${toolName} must route by workspaceId`);
    assert.equal(inputSchema.properties?.deviceId, undefined, `${toolName} must not expose deviceId`);
  }
  const runCommandInput = byName.get("run_command")?.inputSchema as JsonSchemaNode;
  assert.deepEqual(
    new Set(runCommandInput.required ?? []),
    new Set(["workspaceId", "command"]),
  );
  const commandSchema = runCommandInput.properties?.command;
  assert.equal(commandSchema?.anyOf?.length, 2);
  const commandRequired = commandSchema?.anyOf?.map((branch) =>
    new Set(branch.required ?? [])
  ) ?? [];
  assert.ok(commandRequired.some((required) =>
    required.has("argv") && !required.has("shellCommand")
  ));
  assert.ok(commandRequired.some((required) =>
    required.has("shellCommand") && !required.has("argv")
  ));
  assert.ok(commandSchema?.anyOf?.every((branch) => branch.additionalProperties === false));
  assert.equal(byName.get("run_command")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("run_command")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("run_command")?.annotations?.openWorldHint, true);
  assert.match(
    byName.get("run_command")?.description ?? "",
    /accessProfile system.*permissions\.runCommands true.*full permissions.*inherited environment and credentials.*network access.*not confined to the exposed root.*may affect local or external systems/,
  );
  assert.match(
    byName.get("run_command")?.description ?? "",
    /Do not use it for general web research, credential or environment inspection, bypassing file-tool boundaries/,
  );
  assert.match(
    byName.get("run_command")?.description ?? "",
    /Inputs that appear to contain access credentials are rejected.*output appears to contain them.*suppresses the output and stops the command/,
  );
  assert.match(
    byName.get("run_command")?.description ?? "",
    /waitMs 0.*1500 to 2000.*default is 750/i,
  );
  const argvCommandSchema = commandSchema?.anyOf?.find((branch) =>
    branch.properties?.argv
  );
  const shellCommandSchema = commandSchema?.anyOf?.find((branch) =>
    branch.properties?.shellCommand
  );
  assert.match(
    String(argvCommandSchema?.properties?.argv?.description),
    /Preferred for native executables.*without shell startup.*Windows.*npm/,
  );
  assert.match(
    String(shellCommandSchema?.properties?.shellCommand?.description),
    /Use when shell features are required.*Windows.*npm.*PowerShell/,
  );
  assert.match(
    String(runCommandInput.properties?.waitMs?.description),
    /Use 0.*1500 to 2000.*Defaults to 750/,
  );
  const readCommandOutputTool = byName.get("read_command_output");
  assert.equal(readCommandOutputTool?.annotations?.readOnlyHint, true);
  assert.equal(readCommandOutputTool?.annotations?.destructiveHint, false);
  assert.equal(readCommandOutputTool?.annotations?.openWorldHint, false);
  assert.match(
    readCommandOutputTool?.description ?? "",
    /workspaceId and commandId.*one bounded retained byte range.*without rerunning.*Follow nextOffset.*transient.*capped per stream.*deleted with the command record/,
  );
  const readCommandOutputInputSchema = readCommandOutputTool?.inputSchema as {
    required?: string[];
    properties?: Record<string, { description?: unknown }>;
  };
  assert.equal(readCommandOutputInputSchema.required?.includes("workspaceId"), true);
  assert.equal(readCommandOutputInputSchema.required?.includes("commandId"), true);
  assert.equal(readCommandOutputInputSchema.required?.includes("stream"), true);
  assert.match(
    String(readCommandOutputInputSchema.properties?.maxBytes?.description),
    /4 through 65536.*Defaults to 32768/,
  );
  assert.match(
    MCP_SERVER_INSTRUCTIONS,
    /output is truncated.*read_command_output.*workspaceId and commandId.*rather than rerunning/,
  );
  assert.match(
    byName.get("list_workspaces")?.description ?? "",
    /no earlier Glossa result identifies.*required permission is unknown.*worker versions, access profiles, permissions, and protocol capabilities.*Do not call it repeatedly.*ambiguous.*unique --label.*empty result includes setup guidance/,
  );
  assert.doesNotMatch(
    JSON.stringify(byName.get("list_workspaces")?.outputSchema),
    /\bWindows\b/,
  );
  const listWorkspacesSchema = byName.get("list_workspaces")?.outputSchema as JsonSchemaNode;
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.workspaceId,
  );
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.workspaceLabel,
  );
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.workerVersion,
  );
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.accessProfile,
  );
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.permissions,
  );
  assert.ok(
    listWorkspacesSchema.properties?.workspaces?.items?.properties?.capabilities,
  );

  for (const toolName of ["get_command", "cancel_command"]) {
    const inputSchema = byName.get(toolName)?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(inputSchema.properties?.workspaceId);
    assert.equal(inputSchema.required?.includes("workspaceId") ?? false, true);
  }
  const searchTextInputSchema = byName.get("search_text")?.inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(searchTextInputSchema.properties?.matchMode);
  assert.ok(searchTextInputSchema.properties?.includeGlobs);
  assert.ok(searchTextInputSchema.properties?.excludeGlobs);

  const getCommandInputSchema = byName.get("get_command")?.inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(getCommandInputSchema.properties?.afterSequence);

  const commandOutputSchema = byName.get("get_command")?.outputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(commandOutputSchema.properties?.workspaceId);
  assert.equal(commandOutputSchema.properties?.deviceId, undefined);
  assert.ok(commandOutputSchema.properties?.commandId);
  assert.ok(commandOutputSchema.properties?.status);
  assert.ok(commandOutputSchema.properties?.sequence);
  assert.equal(commandOutputSchema.properties?.startedAt, undefined);
  assert.equal(commandOutputSchema.properties?.finishedAt, undefined);

  assert.equal(byName.get("write_file")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("write_file")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("write_file")?.annotations?.openWorldHint, false);
  assert.equal(byName.get("edit_file")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("edit_file")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("edit_file")?.annotations?.openWorldHint, false);
  assert.match(byName.get("edit_file")?.description ?? "", /exactly once/);
  assert.match(byName.get("read_file")?.description ?? "", /access credentials or authentication secrets.*use read_file_range/);
  assert.match(
    byName.get("view_image")?.description ?? "",
    /PNG, JPEG, or WebP.*native MCP image content.*does not OCR or transform.*opaque to Glossa's text secret detector.*Restricted Data/,
  );
  const viewImageOutput = byName.get("view_image")?.outputSchema as JsonSchemaNode;
  assert.ok(viewImageOutput.properties?.mimeType);
  assert.ok(viewImageOutput.properties?.bytes);
  assert.ok(viewImageOutput.properties?.sha256);
  assert.equal(viewImageOutput.properties?.data, undefined);
  assert.match(byName.get("read_file_range")?.description ?? "", /use read_file/i);
  assert.match(byName.get("write_file")?.description ?? "", /without expectedSha256.*fails if the path already exists.*with expectedSha256.*exact existing revision.*use edit_file/i);
  assert.match(byName.get("edit_file")?.description ?? "", /use write_file/i);
  assert.match(byName.get("search_text")?.description ?? "", /literal or regex.*include\/exclude glob.*structured controls.*run_command\/ripgrep/);
  assert.match(byName.get("get_command")?.description ?? "", /afterSequence with waitMs/);
  assert.match(byName.get("cancel_command")?.description ?? "", /does not undo.*effects/);
  const writeFileSchema = byName.get("write_file")?.inputSchema as {
    properties?: Record<string, { description?: unknown }>;
  };
  const editFileSchema = byName.get("edit_file")?.inputSchema as {
    properties?: Record<string, { description?: unknown }>;
  };
  assert.match(
    String(writeFileSchema.properties?.expectedSha256?.description),
    /read_file or read_file_range.*omit only when creating.*replaces exactly.*missing or changed/i,
  );
  assert.match(
    String(editFileSchema.properties?.expectedSha256?.description),
    /read_file or read_file_range.*edit fails if the file changed/,
  );

  const result = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    product,
    documentationUrl: managedDocumentationUrl,
    workspaces: [],
    availability: "offline",
    message: "No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run `glossa`. Keep that terminal open. Retry only after the user confirms the workspace is running. See https://glossa.sh/docs/quickstart for setup help.",
  });
  assert.match(
    String(result.structuredContent?.message),
    /open a terminal.*run `glossa`.*Keep that terminal open.*Retry only after the user confirms/,
  );
  assert.match(
    String(result.structuredContent?.message),
    /https:\/\/glossa\.sh\/docs\/quickstart/,
  );
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: JSON.stringify({
        product,
        documentationUrl: managedDocumentationUrl,
        workspaces: [],
        availability: "offline",
        message: "No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run `glossa`. Keep that terminal open. Retry only after the user confirms the workspace is running. See https://glossa.sh/docs/quickstart for setup help.",
      }),
    },
  ]);

  const onlineWorkerId = "00000000-0000-4000-8000-000000000003";
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000002",
    "Test PC",
    onlineWorkerId,
  );
  const onlineResult = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.deepEqual(onlineResult.structuredContent, {
    product,
    documentationUrl: managedDocumentationUrl,
    workspaces: [{
      workspaceId: onlineWorkerId,
      name: "Test PC",
      path: ".",
      accessProfile: "system",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
      },
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: true,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    }],
    availability: "online",
    message: "Glossa workspaces are available. Select one whose permissions match the requested operation.",
  });

  const selfHostedState = new RouterState();
  const selfHostedServer = createMcpServer(
    testConfig("https://mcp.example.com"),
    selfHostedState,
    accountId,
  );
  const selfHostedClient = new Client({ name: "glossa-self-hosted-test", version: "1.0.0" });
  const [selfHostedClientTransport, selfHostedServerTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([selfHostedClient.close(), selfHostedServer.close()]);
  });
  await selfHostedServer.connect(selfHostedServerTransport);
  await selfHostedClient.connect(selfHostedClientTransport);
  const selfHostedResult = await selfHostedClient.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(selfHostedResult.isError, undefined);
  const selfHostedMessage = String(
    (selfHostedResult.structuredContent as { message?: unknown }).message,
  );
  assert.deepEqual(
    (selfHostedResult.structuredContent as { product?: unknown }).product,
    product,
  );
  assert.equal(
    (selfHostedResult.structuredContent as { documentationUrl?: unknown })
      .documentationUrl,
    selfHostingDocumentationUrl,
  );
  assert.match(
    selfHostedMessage,
    /https:\/\/github\.com\/ariobarin\/glossa\/blob\/main\/docs\/self-hosting\.md/,
  );
  assert.doesNotMatch(
    selfHostedMessage,
    /glossa\.sh\/docs\/quickstart/,
  );
  assert.equal(
    selfHostedMessage,
    `No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and start Glossa using the platform-specific worker command at ${selfHostingDocumentationUrl}. Keep that terminal open. Retry only after the user confirms the workspace is running.`,
  );
  assert.doesNotMatch(selfHostedMessage, /run `glossa`/);

  selfHostedState.register(
    accountId,
    "00000000-0000-4000-8000-000000000004",
    "Self-hosted PC",
    "00000000-0000-4000-8000-000000000005",
    {
      accessProfile: "workspace",
      workerVersion: "1.0.0",
    },
  );
  const selfHostedOnlineResult = await selfHostedClient.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.equal(
    (selfHostedOnlineResult.structuredContent as {
      documentationUrl?: unknown;
    }).documentationUrl,
    selfHostingDocumentationUrl,
  );
  assert.deepEqual(
    (selfHostedOnlineResult.structuredContent as { product?: unknown }).product,
    product,
  );
  assert.equal(
    (selfHostedOnlineResult.structuredContent as { availability?: unknown })
      .availability,
    "online",
  );
  assert.deepEqual(
    (selfHostedOnlineResult.structuredContent as {
      workspaces?: unknown;
    }).workspaces,
    [{
      workspaceId: "00000000-0000-4000-8000-000000000005",
      name: "Self-hosted PC",
      path: ".",
      workerVersion: "1.0.0",
      accessProfile: "workspace",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: false,
      },
      capabilities: {
        commandProgress: true,
        concurrentJobs: true,
        structuredReads: true,
        imageReads: true,
        structuredMutations: true,
        commandOutputRanges: true,
      },
    }],
  );

  const logout = await client.callTool({
    name: "get_logout_instructions",
    arguments: {},
  });
  const logoutUrl = "https://identity.glossa.test/v2/logout";
  assert.equal(logout.isError, undefined);
  assert.deepEqual(logout.structuredContent, {
    logoutUrl,
    instructions: `The Glossa CLI keeps no account session: a computer is either paired or not. To detach a computer, run glossa unpair on it. To switch the account a computer pairs to, end the Auth0 browser session by opening ${logoutUrl}, run glossa unpair on that computer, start glossa there again, and redeem its new pairing code on the control panel while signed in to the intended account. Disconnect and reconnect Glossa in ChatGPT if you are switching the ChatGPT authorization too.`,
  });
  assert.doesNotMatch(JSON.stringify(logout.structuredContent), /Google/);

  const selfHostedLogout = await selfHostedClient.callTool({
    name: "get_logout_instructions",
    arguments: {},
  });
  assert.match(
    JSON.stringify(selfHostedLogout.structuredContent),
    /run glossa unpair/,
  );
  assert.doesNotMatch(JSON.stringify(selfHostedLogout.structuredContent), /Google/);
});


test("returns workspace images as native MCP image content without duplicating bytes", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000090";
  const workerId = "00000000-0000-4000-8000-000000000091";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "read-only",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-image-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const data = "iVBORw0KGgo=";
  const call = client.callTool({
    name: "view_image",
    arguments: { workspaceId: workerId, path: "screenshots/home.png" },
  });
  const job = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(job?.type, "view_image");
  assert.ok(job && job.type === "view_image");
  assert.equal(job.path, "screenshots/home.png");
  state.complete(accountId, workerId, {
    requestId: job.requestId,
    ok: true,
    value: {
      data,
      mimeType: "image/png",
      sha256: "0".repeat(64),
      bytes: Buffer.byteLength(data, "base64"),
    },
  });

  const result = await call;
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    mimeType: "image/png",
    sha256: "0".repeat(64),
    bytes: Buffer.byteLength(data, "base64"),
  });
  assert.deepEqual(result.content, [{
    type: "image",
    data,
    mimeType: "image/png",
  }]);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(data));
});

test("returns an actionable upgrade error instead of dispatching images to legacy workers", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000092";
  const workerId = "00000000-0000-4000-8000-000000000093";
  const session = state.register(accountId, deviceId, "Legacy PC", workerId, {
    accessProfile: "read-only",
    capabilities: {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      imageReads: false,
      structuredMutations: true,
      commandOutputRanges: true,
    },
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-image-legacy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "view_image",
    arguments: { workspaceId: workerId, path: "screenshots/home.png" },
  });
  assert.equal(result.isError, true);
  const content = JSON.stringify(result.content);
  assert.match(content, /worker_protocol_unsupported/);
  assert.match(content, /older Glossa CLI/);
  assert.match(content, /Update Glossa/);
  assert.equal(
    await state.poll(
      accountId,
      deviceId,
      workerId,
      session.generation,
      5,
      new Set(["view_image"]),
    ),
    null,
  );
});

test("returns actionable permission errors without dispatching forbidden work", async (context) => {
  const state = new RouterState();
  const readOnlyWorkerId = "00000000-0000-4000-8000-000000000030";
  const workspaceWorkerId = "00000000-0000-4000-8000-000000000031";
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000032",
    "Review PC",
    readOnlyWorkerId,
    {
      accessProfile: "read-only",
    },
  );
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000033",
    "Review PC",
    workspaceWorkerId,
    {
      accessProfile: "workspace",
    },
  );
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-permission-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const writeResult = await client.callTool({
    name: "write_file",
    arguments: {
      workspaceId: readOnlyWorkerId,
      path: "README.md",
      content: "not dispatched",
    },
  });
  assert.equal(writeResult.isError, true);
  assert.match(JSON.stringify(writeResult.content), /write_access_disabled/);
  assert.match(JSON.stringify(writeResult.content), /Do not retry/);
  assert.match(JSON.stringify(writeResult.content), /workspace access/);

  const deleteResult = await client.callTool({
    name: "delete_path",
    arguments: {
      workspaceId: readOnlyWorkerId,
      path: "README.md",
    },
  });
  assert.equal(deleteResult.isError, true);
  assert.match(JSON.stringify(deleteResult.content), /write_access_disabled/);

  const commandResult = await client.callTool({
    name: "run_command",
    arguments: {
      workspaceId: workspaceWorkerId,
      command: { argv: ["node", "--version"] },
    },
  });
  assert.equal(commandResult.isError, true);
  assert.match(JSON.stringify(commandResult.content), /command_access_disabled/);
  assert.match(JSON.stringify(commandResult.content), /Do not retry/);
  assert.match(JSON.stringify(commandResult.content), /system access/);

  const outputResult = await client.callTool({
    name: "read_command_output",
    arguments: {
      workspaceId: workspaceWorkerId,
      commandId: "00000000-0000-4000-8000-000000000039",
      stream: "stdout",
    },
  });
  assert.equal(outputResult.isError, true);
  assert.match(JSON.stringify(outputResult.content), /command_access_disabled/);
});

test("routes retained command output ranges", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000080";
  const workerId = "00000000-0000-4000-8000-000000000081";
  const commandId = "00000000-0000-4000-8000-000000000084";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "system",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-output-range-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = client.callTool({
    name: "read_command_output",
    arguments: {
      workspaceId: workerId,
      commandId,
      stream: "stderr",
      offset: 4096,
      maxBytes: 8192,
    },
  });
  const job = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(job?.type, "read_command_output");
  assert.ok(job && job.type === "read_command_output");
  assert.equal(job.commandId, commandId);
  assert.equal(job.stream, "stderr");
  assert.equal(job.offset, 4096);
  assert.equal(job.maxBytes, 8192);
  state.complete(accountId, workerId, {
    requestId: job.requestId,
    ok: true,
    value: {
      commandId,
      stream: "stderr",
      status: "failed",
      offset: 4096,
      content: "middle diagnostics",
      nextOffset: 4114,
      retainedBytes: 12000,
      totalBytes: 12000,
      retentionTruncated: false,
      complete: true,
    },
  });
  assert.deepEqual((await call).structuredContent, {
    workspaceId: workerId,
    commandId,
    stream: "stderr",
    status: "failed",
    offset: 4096,
    content: "middle diagnostics",
    nextOffset: 4114,
    retainedBytes: 12000,
    totalBytes: 12000,
    retentionTruncated: false,
    complete: true,
  });

  const errorCall = client.callTool({
    name: "read_command_output",
    arguments: {
      workspaceId: workerId,
      commandId,
      stream: "stdout",
      offset: 99999,
    },
  });
  const errorJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.ok(errorJob);
  state.complete(accountId, workerId, {
    requestId: errorJob.requestId,
    ok: false,
    error: {
      code: "output_offset_out_of_range",
      message: "C:\\private\\worker details",
    },
  });
  const errorResult = await errorCall;
  const serializedError = JSON.stringify(errorResult.content);
  assert.equal(errorResult.isError, true);
  assert.match(serializedError, /output_offset_out_of_range/);
  assert.match(serializedError, /exceeds the retained stream length/);
  assert.doesNotMatch(serializedError, /private|worker details/);

});

test("returns actionable guidance for Windows command shims", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000034";
  const workerId = "00000000-0000-4000-8000-000000000035";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "system",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-shim-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = client.callTool({
    name: "run_command",
    arguments: {
      workspaceId: workerId,
      command: { argv: ["npm.cmd", "--version"] },
    },
  });
  const job = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(job?.type, "run_command");
  assert.ok(job);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: job.requestId,
      ok: false,
      error: {
        code: "windows_command_shim",
        message: "C:\\private\\npm.cmd could not be launched",
      },
    }),
    true,
  );

  const result = await call;
  const serialized = JSON.stringify(result.content);
  assert.equal(result.isError, true);
  assert.match(serialized, /windows_command_shim/);
  assert.match(serialized, /\.cmd and \.bat.*shellCommand.*explicit shim filename/);
  assert.doesNotMatch(serialized, /private/);
});

test("routes structured path lifecycle jobs", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000070";
  const workerId = "00000000-0000-4000-8000-000000000071";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "workspace",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-lifecycle-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const makeCall = client.callTool({
    name: "make_directory",
    arguments: { workspaceId: workerId, path: "build/cache", recursive: true },
  });
  const makeJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(makeJob?.type, "make_directory");
  assert.ok(makeJob && makeJob.type === "make_directory");
  assert.equal(makeJob.path, "build/cache");
  assert.equal(makeJob.recursive, true);
  state.complete(accountId, workerId, {
    requestId: makeJob.requestId,
    ok: true,
    value: { created: true },
  });
  assert.deepEqual((await makeCall).structuredContent, { created: true });

  const moveCall = client.callTool({
    name: "move_path",
    arguments: {
      workspaceId: workerId,
      source: "build/cache",
      destination: "build/archive",
    },
  });
  const moveJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(moveJob?.type, "move_path");
  assert.ok(moveJob && moveJob.type === "move_path");
  assert.equal(moveJob.source, "build/cache");
  assert.equal(moveJob.destination, "build/archive");
  state.complete(accountId, workerId, {
    requestId: moveJob.requestId,
    ok: true,
    value: { movedType: "directory" },
  });
  assert.deepEqual((await moveCall).structuredContent, {
    movedType: "directory",
  });

  const deleteCall = client.callTool({
    name: "delete_path",
    arguments: { workspaceId: workerId, path: "build/archive", recursive: true },
  });
  const deleteJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(deleteJob?.type, "delete_path");
  assert.ok(deleteJob && deleteJob.type === "delete_path");
  assert.equal(deleteJob.recursive, true);
  state.complete(accountId, workerId, {
    requestId: deleteJob.requestId,
    ok: true,
    value: { deletedType: "directory" },
  });
  assert.deepEqual((await deleteCall).structuredContent, {
    deletedType: "directory",
  });

});

test("blocks recognizable authentication data without dispatch or disclosure", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000040";
  const workerId = "00000000-0000-4000-8000-000000000041";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "system",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-restricted-data-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const key = "sk-proj-" + "A".repeat(32);
  for (const call of [
    client.callTool({
      name: "read_file",
      arguments: { workspaceId: workerId, path: key },
    }),
    client.callTool({
      name: "view_image",
      arguments: { workspaceId: workerId, path: key },
    }),
    client.callTool({
      name: "search_text",
      arguments: { workspaceId: workerId, query: key },
    }),
    client.callTool({
      name: "write_file",
      arguments: { workspaceId: workerId, path: "secret.txt", content: key },
    }),
    client.callTool({
      name: "run_command",
      arguments: {
        workspaceId: workerId,
        command: {
          argv: ["node", "-e", `process.stdout.write(${JSON.stringify(key)})`],
        },
      },
    }),
  ]) {
    const result = await call;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /restricted_data_blocked/);
    assert.match(JSON.stringify(result.content), /access credentials or authentication secrets/);
    assert.doesNotMatch(JSON.stringify(result.content), new RegExp(key));
  }

  assert.equal(
    await state.poll(
      accountId,
      deviceId,
      workerId,
      session.generation,
      5,
    ),
    null,
  );

  const readCall = client.callTool({
    name: "read_file",
    arguments: { workspaceId: workerId, path: "secret.txt" },
  });
  const readJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(readJob?.type, "read_file");
  assert.ok(readJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: readJob.requestId,
      ok: false,
      error: {
        code: "restricted_data_blocked",
        message: key,
      },
    }),
    true,
  );
  const readResult = await readCall;
  assert.equal(readResult.isError, true);
  assert.match(JSON.stringify(readResult.content), /restricted_data_blocked/);
  assert.doesNotMatch(JSON.stringify(readResult.content), new RegExp(key));
});

test("returns safe actionable messages for public file-policy errors", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000050";
  const workerId = "00000000-0000-4000-8000-000000000051";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    accessProfile: "workspace",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-file-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const cases = [
    ["invalid_path", "The requested path is invalid."],
    ["absolute_path", "Absolute paths are not allowed."],
    ["path_traversal", "Parent path traversal is not allowed."],
    ["parent_not_found", "The destination directory does not exist."],
    ["linked_path", "Symlink and junction paths are not allowed."],
    ["file_changed", "The file changed while it was being read."],
    ["search_byte_limit", "The repository search byte limit was reached. Narrow the requested path."],
    ["unsafe_temporary_file", "The atomic write could not be completed safely."],
  ] as const;

  for (const [code, expectedMessage] of cases) {
    const call = client.callTool({
      name: "read_file",
      arguments: { workspaceId: workerId, path: "fixture.txt" },
    });
    const job = await state.poll(
      accountId,
      deviceId,
      workerId,
      session.generation,
      100,
    );
    assert.equal(job?.type, "read_file");
    assert.ok(job);
    assert.equal(
      state.complete(accountId, workerId, {
        requestId: job.requestId,
        ok: false,
        error: {
          code,
          message: "C:\\private\\workspace\\details must not be relayed",
        },
      }),
      true,
    );
    const result = await call;
    const serialized = JSON.stringify(result.content);
    assert.equal(result.isError, true);
    assert.ok(serialized.includes(code));
    assert.ok(serialized.includes(expectedMessage));
    assert.doesNotMatch(serialized, /private|workspace\\details/);
  }

  const unknownCall = client.callTool({
    name: "read_file",
    arguments: { workspaceId: workerId, path: "fixture.txt" },
  });
  const unknownJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.ok(unknownJob);
  state.complete(accountId, workerId, {
    requestId: unknownJob.requestId,
    ok: false,
    error: { code: "unclassified_worker_error", message: "local details" },
  });
  const unknownResult = await unknownCall;
  assert.match(JSON.stringify(unknownResult.content), /The local worker operation failed/);
});

test("redacts restricted device metadata from list_workspaces", async (context) => {
  const state = new RouterState();
  const key = "sk-proj-" + "A".repeat(32);
  const workerId = "00000000-0000-4000-8000-000000000042";
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000043",
    key,
    workerId,
    {
      accessProfile: "workspace",
      workspaceLabel: key,
    },
  );
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-restricted-metadata-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({ name: "list_workspaces", arguments: {} });
  assert.equal(result.isError, undefined);
  const serialized = JSON.stringify(result.structuredContent);
  assert.doesNotMatch(serialized, new RegExp(key));
  assert.match(serialized, /restricted device name blocked/);
  assert.doesNotMatch(serialized, /workspaceLabel/);
});

test("does not mirror large structured results into text content", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000020";
  const workerId = "00000000-0000-4000-8000-000000000021";
  const session = state.register(accountId, deviceId, "Test PC", workerId);
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-large-result-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const content = "x".repeat(64 * 1024);
  const readCall = client.callTool({
    name: "read_file",
    arguments: { workspaceId: workerId, path: "large.txt" },
  });
  const readJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(readJob?.type, "read_file");
  assert.ok(readJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: readJob.requestId,
      ok: true,
      value: { content, sha256: "0".repeat(64), bytes: Buffer.byteLength(content) },
    }),
    true,
  );

  const result = await readCall;
  const structured = result.structuredContent as { content?: unknown } | undefined;
  const resultContent = result.content as Array<{ type?: unknown; text?: unknown }>;
  assert.equal(structured?.content, content);
  const text = String(
    resultContent[0]?.type === "text" ? resultContent[0].text ?? "" : "",
  );
  assert.match(text, /Full result is available in structuredContent/);
  assert.doesNotMatch(text, /x{100}/);
  assert.ok(Buffer.byteLength(text, "utf8") < 256);
});

test("reserves relay headroom for maximum command status waits", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000060";
  const workerId = "00000000-0000-4000-8000-000000000061";
  const commandId = "00000000-0000-4000-8000-000000000062";
  const session = state.register(accountId, deviceId, "Test PC", workerId, {
    accessProfile: "system",
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-command-wait-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  for (const [requestedWaitMs, expectedWaitMs] of [
    [15_000, 13_000],
    [12_000, 12_000],
  ] as const) {
    const call = client.callTool({
      name: "get_command",
      arguments: {
        workspaceId: workerId,
        commandId,
        waitMs: requestedWaitMs,
        afterSequence: 0,
      },
    });
    const job = await state.poll(
      accountId,
      deviceId,
      workerId,
      session.generation,
      100,
    );
    assert.equal(job?.type, "get_command");
    assert.ok(job);
    assert.equal(job.waitMs, expectedWaitMs);
    assert.equal(
      state.complete(accountId, workerId, {
        requestId: job.requestId,
        ok: true,
        value: { commandId, status: "running", sequence: 0 },
      }),
      true,
    );
    const result = await call;
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as { status?: unknown } | undefined)?.status,
      "running",
    );
  }
});

test("routes command follow-ups only by explicit workspaceId", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000010";
  const workerId = "00000000-0000-4000-8000-000000000011";
  const commandId = "00000000-0000-4000-8000-000000000012";
  const canceledCommandId = "00000000-0000-4000-8000-000000000013";
  const otherDeviceId = "00000000-0000-4000-8000-000000000014";
  const otherWorkerId = "00000000-0000-4000-8000-000000000015";
  const session = state.register(accountId, deviceId, "Test PC", workerId);
  const otherSession = state.register(
    accountId,
    otherDeviceId,
    "Other PC",
    otherWorkerId,
  );
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-explicit-command-route-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const runCall = client.callTool({
    name: "run_command",
    arguments: { workspaceId: workerId, command: { argv: ["echo", "ok"] } },
  });
  const runJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(runJob?.type, "run_command");
  assert.ok(runJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: runJob.requestId,
      ok: true,
      value: { commandId, status: "running", sequence: 1 },
    }),
    true,
  );
  const runResult = await runCall;
  assert.deepEqual(runResult.structuredContent, {
    workspaceId: workerId,
    commandId,
    status: "running",
    sequence: 1,
  });

  for (const toolName of ["get_command", "cancel_command"]) {
    const misroutedCall = client.callTool({
      name: toolName,
      arguments: { workspaceId: otherWorkerId, commandId },
    });
    const misroutedJob = await state.poll(
      accountId,
      otherDeviceId,
      otherWorkerId,
      otherSession.generation,
      100,
    );
    assert.equal(misroutedJob?.type, toolName);
    assert.ok(misroutedJob);
    assert.equal(
      state.complete(accountId, otherWorkerId, {
        requestId: misroutedJob.requestId,
        ok: false,
        error: {
          code: "command_not_found",
          message: "The command was not found.",
        },
      }),
      true,
    );
    const misroutedResult = await misroutedCall;
    assert.equal(misroutedResult.isError, true);
    assert.match(
      JSON.stringify(misroutedResult.content),
      /command_not_found/,
    );
  }

  const getCall = client.callTool({
    name: "get_command",
    arguments: { workspaceId: workerId, commandId },
  });
  const getJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(getJob?.type, "get_command");
  assert.ok(getJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: getJob.requestId,
      ok: true,
      value: { commandId, status: "succeeded", sequence: 2, exitCode: 0 },
    }),
    true,
  );
  const getResult = await getCall;
  assert.deepEqual(getResult.structuredContent, {
    workspaceId: workerId,
    commandId,
    status: "succeeded",
    sequence: 2,
    exitCode: 0,
  });

  const missingRoute = await client.callTool({
    name: "get_command",
    arguments: { commandId },
  });
  assert.equal(missingRoute.isError, true);
  assert.match(JSON.stringify(missingRoute.content), /workspaceId/);

  const secondRunCall = client.callTool({
    name: "run_command",
    arguments: { workspaceId: workerId, command: { argv: ["sleep", "10"] } },
  });
  const secondRunJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(secondRunJob?.type, "run_command");
  assert.ok(secondRunJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: secondRunJob.requestId,
      ok: true,
      value: { commandId: canceledCommandId, status: "running", sequence: 1 },
    }),
    true,
  );
  await secondRunCall;

  const cancelCall = client.callTool({
    name: "cancel_command",
    arguments: { workspaceId: workerId, commandId: canceledCommandId },
  });
  const cancelJob = await state.poll(
    accountId,
    deviceId,
    workerId,
    session.generation,
    100,
  );
  assert.equal(cancelJob?.type, "cancel_command");
  assert.ok(cancelJob);
  assert.equal(
    state.complete(accountId, workerId, {
      requestId: cancelJob.requestId,
      ok: true,
      value: {
        commandId: canceledCommandId,
        status: "canceled",
        sequence: 2,
      },
    }),
    true,
  );
  const cancelResult = await cancelCall;
  assert.deepEqual(cancelResult.structuredContent, {
    workspaceId: workerId,
    commandId: canceledCommandId,
    status: "canceled",
    sequence: 2,
  });
});
