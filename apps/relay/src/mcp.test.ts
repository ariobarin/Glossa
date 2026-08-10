import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import {
  createMcpServer,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_VERSION,
} from "./mcp.js";
import { RouterState } from "./router-state.js";

const expectedTools = [
  "cancel_command",
  "edit_file",
  "get_command",
  "list_devices",
  "list_files",
  "logout",
  "read_file",
  "read_file_range",
  "run_command",
  "search_text",
  "write_file",
];
const expectedToolTitles: Record<string, string> = {
  cancel_command: "Stop Workspace Command",
  edit_file: "Edit Workspace File",
  get_command: "Check Workspace Command",
  list_devices: "Find Glossa Workspaces",
  list_files: "List Workspace Files",
  logout: "Get Glossa Sign-Out Steps",
  read_file: "Read Workspace File",
  read_file_range: "Read Workspace File Range",
  run_command: "Run Workspace Command",
  search_text: "Search Workspace Text",
  write_file: "Create or Replace Workspace File",
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

  assert.equal(MCP_SERVER_VERSION, "1.0.0");
  assert.equal(client.getServerVersion()?.version, MCP_SERVER_VERSION);
  assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Use Glossa only to work in a local development workspace/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /do not use it for general questions, web research, built-in ChatGPT tasks/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /inspect accessProfile and permissions/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Never attempt a write when writeFiles is false or a command when runCommands is false/);
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
    /local worker suppresses recognizable credential material.*defense in depth, not a sandbox/,
  );

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
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations?.idempotentHint, "boolean");
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean");
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
  const runCommandInputSchema = byName.get("run_command")?.inputSchema as {
    properties?: Record<string, { description?: unknown }>;
  };
  assert.match(
    String(runCommandInputSchema.properties?.argv?.description),
    /Preferred for native executables.*without shell startup.*Windows.*npm/,
  );
  assert.match(
    String(runCommandInputSchema.properties?.shellCommand?.description),
    /Use when shell features are required.*Windows.*npm.*PowerShell/,
  );
  assert.match(
    String(runCommandInputSchema.properties?.waitMs?.description),
    /Use 0.*1500 to 2000.*Defaults to 750/,
  );
  assert.match(
    byName.get("list_devices")?.description ?? "",
    /no earlier Glossa result identifies.*required permission is unknown.*worker versions, access profiles, permissions, and negotiated capabilities.*Do not call it repeatedly.*ambiguous.*unique --label.*empty result includes setup guidance/,
  );
  assert.doesNotMatch(
    JSON.stringify(byName.get("list_devices")?.outputSchema),
    /\bWindows\b/,
  );
  const listDevicesSchema = byName.get("list_devices")?.outputSchema as JsonSchemaNode;
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.workspaceLabel,
  );
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.workerVersion,
  );
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.accessProfile,
  );
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.permissions,
  );
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.capabilities,
  );

  for (const toolName of ["get_command", "cancel_command"]) {
    const inputSchema = byName.get(toolName)?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(inputSchema.properties?.deviceId);
    assert.equal(inputSchema.required?.includes("deviceId") ?? false, false);
  }
  const getCommandInputSchema = byName.get("get_command")?.inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(getCommandInputSchema.properties?.afterSequence);

  const commandOutputSchema = byName.get("get_command")?.outputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(commandOutputSchema.properties?.deviceId);
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
  assert.match(byName.get("read_file_range")?.description ?? "", /use read_file/i);
  assert.match(byName.get("write_file")?.description ?? "", /use edit_file/i);
  assert.match(byName.get("edit_file")?.description ?? "", /use write_file/i);
  assert.match(byName.get("search_text")?.description ?? "", /does not interpret regular expressions/);
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
    /read_file or read_file_range.*write fails if the file changed/,
  );
  assert.match(
    String(editFileSchema.properties?.expectedSha256?.description),
    /read_file or read_file_range.*edit fails if the file changed/,
  );

  const result = await client.callTool({
    name: "list_devices",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    product,
    documentationUrl: managedDocumentationUrl,
    devices: [],
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
        devices: [],
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
    name: "list_devices",
    arguments: {},
  });
  assert.deepEqual(onlineResult.structuredContent, {
    product,
    documentationUrl: managedDocumentationUrl,
    devices: [{
      deviceId: onlineWorkerId,
      name: "Test PC",
      path: ".",
      accessProfile: "system",
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
      },
      capabilities: {
        commandProgress: false,
        concurrentJobs: false,
        structuredReads: false,
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
    name: "list_devices",
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
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      accessProfile: "workspace",
      workerVersion: "1.0.0",
    },
  );
  const selfHostedOnlineResult = await selfHostedClient.callTool({
    name: "list_devices",
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
      devices?: unknown;
    }).devices,
    [{
      deviceId: "00000000-0000-4000-8000-000000000005",
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
      },
    }],
  );

  const logout = await client.callTool({
    name: "logout",
    arguments: {},
  });
  const logoutUrl = "https://identity.glossa.test/v2/logout";
  assert.equal(logout.isError, undefined);
  assert.deepEqual(logout.structuredContent, {
    logoutUrl,
    instructions: `Run glossa logout. Stop any other Glossa sessions with Ctrl+C. If the CLI does not open a browser, open ${logoutUrl}. Then disconnect and reconnect Glossa in ChatGPT. The CLI starts sign-in automatically the next time it needs an account. Choose the same intended sign-in account for both authorizations.`,
  });
  assert.doesNotMatch(JSON.stringify(logout.structuredContent), /Google/);

  const selfHostedLogout = await selfHostedClient.callTool({
    name: "logout",
    arguments: {},
  });
  assert.match(
    JSON.stringify(selfHostedLogout.structuredContent),
    /same intended sign-in account/,
  );
  assert.doesNotMatch(JSON.stringify(selfHostedLogout.structuredContent), /Google/);
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
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      accessProfile: "read-only",
    },
  );
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000033",
    "Review PC",
    workspaceWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
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
      deviceId: readOnlyWorkerId,
      path: "README.md",
      content: "not dispatched",
    },
  });
  assert.equal(writeResult.isError, true);
  assert.match(JSON.stringify(writeResult.content), /write_access_disabled/);
  assert.match(JSON.stringify(writeResult.content), /Do not retry/);
  assert.match(JSON.stringify(writeResult.content), /workspace access/);

  const commandResult = await client.callTool({
    name: "run_command",
    arguments: {
      deviceId: workspaceWorkerId,
      argv: ["node", "--version"],
    },
  });
  assert.equal(commandResult.isError, true);
  assert.match(JSON.stringify(commandResult.content), /command_access_disabled/);
  assert.match(JSON.stringify(commandResult.content), /Do not retry/);
  assert.match(JSON.stringify(commandResult.content), /system access/);
});

test("returns actionable guidance for Windows command shims", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000034";
  const workerId = "00000000-0000-4000-8000-000000000035";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
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
      deviceId: workerId,
      argv: ["npm.cmd", "--version"],
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

test("blocks recognizable authentication data without dispatch or disclosure", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000040";
  const workerId = "00000000-0000-4000-8000-000000000041";
  const session = state.register(accountId, deviceId, "Review PC", workerId, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
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
      arguments: { deviceId: workerId, path: key },
    }),
    client.callTool({
      name: "search_text",
      arguments: { deviceId: workerId, query: key },
    }),
    client.callTool({
      name: "write_file",
      arguments: { deviceId: workerId, path: "secret.txt", content: key },
    }),
    client.callTool({
      name: "run_command",
      arguments: {
        deviceId: workerId,
        argv: ["node", "-e", `process.stdout.write(${JSON.stringify(key)})`],
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
    arguments: { deviceId: workerId, path: "secret.txt" },
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
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
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
      arguments: { deviceId: workerId, path: "fixture.txt" },
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
    arguments: { deviceId: workerId, path: "fixture.txt" },
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

test("redacts restricted legacy device metadata from list_devices", async (context) => {
  const state = new RouterState();
  const key = "sk-proj-" + "A".repeat(32);
  const workerId = "00000000-0000-4000-8000-000000000042";
  state.register(
    accountId,
    "00000000-0000-4000-8000-000000000043",
    key,
    workerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
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

  const result = await client.callTool({ name: "list_devices", arguments: {} });
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
  const session = state.register(accountId, deviceId, "Test PC", workerId, {
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
  });
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
    arguments: { deviceId: workerId, path: "large.txt" },
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
    commandProgress: true,
    concurrentJobs: true,
    structuredReads: true,
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
        deviceId: workerId,
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

test("routes cached command schemas without deviceId", async (context) => {
  const state = new RouterState();
  const deviceId = "00000000-0000-4000-8000-000000000010";
  const workerId = "00000000-0000-4000-8000-000000000011";
  const commandId = "00000000-0000-4000-8000-000000000012";
  const canceledCommandId = "00000000-0000-4000-8000-000000000013";
  const otherDeviceId = "00000000-0000-4000-8000-000000000014";
  const otherWorkerId = "00000000-0000-4000-8000-000000000015";
  const session = state.register(accountId, deviceId, "Test PC", workerId, {
    commandProgress: true,
    concurrentJobs: true,
  });
  const otherSession = state.register(
    accountId,
    otherDeviceId,
    "Other PC",
    otherWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
    },
  );
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-legacy-command-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const runCall = client.callTool({
    name: "run_command",
    arguments: { deviceId: workerId, argv: ["echo", "ok"] },
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
    deviceId: workerId,
    commandId,
    status: "running",
    sequence: 1,
  });

  for (const toolName of ["get_command", "cancel_command"]) {
    const misroutedCall = client.callTool({
      name: toolName,
      arguments: { deviceId: otherWorkerId, commandId },
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
    arguments: { commandId },
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
    deviceId: workerId,
    commandId,
    status: "succeeded",
    sequence: 2,
    exitCode: 0,
  });

  const expiredRoute = await client.callTool({
    name: "get_command",
    arguments: { commandId },
  });
  assert.equal(expiredRoute.isError, true);
  assert.match(JSON.stringify(expiredRoute.content), /command_not_found/);

  const secondRunCall = client.callTool({
    name: "run_command",
    arguments: { deviceId: workerId, argv: ["sleep", "10"] },
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
    arguments: { commandId: canceledCommandId },
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
    deviceId: workerId,
    commandId: canceledCommandId,
    status: "canceled",
    sequence: 2,
  });
});

test("structured repository tools require a current worker", async (context) => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const deviceId = "00000000-0000-4000-8000-000000000002";
  const workerId = "00000000-0000-4000-8000-000000000003";
  const state = new RouterState();
  state.register(accountId, deviceId, "Test PC", workerId, {
    commandProgress: true,
    concurrentJobs: true,
  });
  const server = createMcpServer(testConfig(), state, accountId);
  const client = new Client({ name: "glossa-structured-read-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "list_files",
    arguments: { deviceId: workerId },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /worker_update_required/);
  assert.match(JSON.stringify(result.content), /Update and reconnect/);
});
