import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createMcpServer, MCP_SERVER_VERSION } from "./mcp.js";
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
const accountId = "00000000-0000-4000-8000-000000000001";
const product = {
  name: "Glossa",
  description: "The local bridge between ChatGPT and one explicitly exposed workspace.",
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

  assert.equal(MCP_SERVER_VERSION, "0.1.0-beta.14");
  assert.equal(client.getServerVersion()?.version, MCP_SERVER_VERSION);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    expectedTools,
  );

  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} must have a title`);
    assert.ok(tool.description, `${tool.name} must have a description`);
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
  assert.match(byName.get("run_command")?.description ?? "", /network access/);
  assert.match(byName.get("run_command")?.description ?? "", /Prefer argv/);
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
    String(runCommandInputSchema.properties?.windowsShell?.description),
    /Windows-only.*PowerShell.*cmd.*faster/,
  );
  assert.match(
    byName.get("list_devices")?.description ?? "",
    /deployment-specific start instructions.*then retry/,
  );
  assert.doesNotMatch(
    JSON.stringify(byName.get("list_devices")?.outputSchema),
    /\bWindows\b/,
  );
  const listDevicesSchema = byName.get("list_devices")?.outputSchema as JsonSchemaNode;
  assert.ok(
    listDevicesSchema.properties?.devices?.items?.properties?.workspaceLabel,
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
    message: "No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run `glossa`. Keep that terminal open, wait for the workspace to appear, then retry. See https://glossa.sh/docs/quickstart for setup help.",
  });
  assert.match(
    String(result.structuredContent?.message),
    /open a terminal.*run `glossa`.*Keep that terminal open.*then retry\./,
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
        message: "No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run `glossa`. Keep that terminal open, wait for the workspace to appear, then retry. See https://glossa.sh/docs/quickstart for setup help.",
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
    devices: [{ deviceId: onlineWorkerId, name: "Test PC", path: "." }],
    availability: "online",
    message: "Glossa workspaces are available.",
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
    `No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and start Glossa using the platform-specific worker command at ${selfHostingDocumentationUrl}. Keep that terminal open, wait for the workspace to appear, then retry.`,
  );
  assert.doesNotMatch(selfHostedMessage, /run `glossa`/);

  selfHostedState.register(
    accountId,
    "00000000-0000-4000-8000-000000000004",
    "Self-hosted PC",
    "00000000-0000-4000-8000-000000000005",
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

  const logout = await client.callTool({
    name: "logout",
    arguments: {},
  });
  const logoutUrl = "https://identity.glossa.test/v2/logout";
  assert.equal(logout.isError, undefined);
  assert.deepEqual(logout.structuredContent, {
    logoutUrl,
    instructions: `Run glossa logout. Stop any other Glossa sessions with Ctrl+C. If the CLI does not open a browser, open ${logoutUrl}. Then disconnect and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. Choose the same intended Google account for both authorizations.`,
  });
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
