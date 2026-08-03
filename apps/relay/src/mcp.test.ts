import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BindingState } from "./binding-state.js";
import { loadConfig } from "./config.js";
import { createMcpServer, MCP_SERVER_VERSION } from "./mcp.js";
import { RouterState } from "./router-state.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";
const deviceId = "00000000-0000-4000-8000-000000000003";
const alphaWorkerId = "00000000-0000-4000-8000-000000000004";
const betaWorkerId = "00000000-0000-4000-8000-000000000005";
const alphaWorkspaceId = "00000000-0000-4000-8000-000000000006";
const betaWorkspaceId = "00000000-0000-4000-8000-000000000007";
const expectedTools = [
  "cancel_command",
  "edit_file",
  "get_command",
  "list_files",
  "list_workspaces",
  "logout",
  "read_file",
  "read_file_range",
  "run_command",
  "search_text",
  "select_workspace",
  "write_file",
];

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GLOSSA_PUBLIC_ORIGIN: "https://mcp.glossa.sh",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://mcp.glossa.test/",
  });
}

async function connect(
  context: TestContext,
  state: RouterState,
  bindings = new BindingState(),
  account = accountId,
): Promise<Client> {
  const server = createMcpServer(testConfig(), state, account, bindings);
  const client = new Client({ name: "glossa-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function errorCode(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(first?.type, "text");
  if (first?.type !== "text") assert.fail("Expected a text error");
  return (JSON.parse(first.text!) as { error: { code: string } }).error.code;
}

function structured<T>(
  result: Awaited<ReturnType<Client["callTool"]>>,
): T {
  return result.structuredContent as T;
}

function registerWorkspaces(state: RouterState) {
  const alpha = state.register(
    accountId,
    deviceId,
    "Test PC",
    alphaWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      workspaceId: alphaWorkspaceId,
      rootPath: "C:\\code\\alpha",
      workspaceLabel: "alpha",
    },
  );
  const beta = state.register(
    accountId,
    deviceId,
    "Test PC",
    betaWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      workspaceId: betaWorkspaceId,
      rootPath: "C:\\code\\beta",
      workspaceLabel: "beta",
    },
  );
  return { alpha, beta };
}

async function answerRead(
  state: RouterState,
  workerId: string,
  generation: string,
  content: string,
): Promise<void> {
  const job = await state.poll(
    accountId,
    deviceId,
    workerId,
    generation,
    100,
  );
  assert.equal(job?.type, "read_file");
  assert.ok(job);
  state.complete(accountId, workerId, {
    requestId: job.requestId,
    ok: true,
    value: { content, sha256: "a".repeat(64), bytes: content.length },
  });
}

test("publishes one fixed workspace-bound tool catalog", async (context) => {
  const client = await connect(context, new RouterState());
  assert.equal(MCP_SERVER_VERSION, "0.1.0-beta.14");
  assert.equal(client.getServerVersion()?.version, MCP_SERVER_VERSION);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedTools);

  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} needs a title`);
    assert.ok(tool.description, `${tool.name} needs a description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    assert.ok(tool.outputSchema, `${tool.name} needs an output schema`);
    assert.equal(tool._meta?.["openai/visibility"], "public");
    assert.deepEqual(tool._meta?.securitySchemes, [
      { type: "oauth2", scopes: ["glossa:access"] },
    ]);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of expectedTools) {
    const schema = byName.get(name)?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(schema.properties?.bindingToken, `${name} needs bindingToken`);
    assert.equal(schema.required?.includes("bindingToken") ?? false, false);
  }
  for (const name of [
    "read_file",
    "list_files",
    "search_text",
    "read_file_range",
    "write_file",
    "edit_file",
    "run_command",
    "get_command",
    "cancel_command",
  ]) {
    const properties = (byName.get(name)?.inputSchema as {
      properties?: Record<string, unknown>;
    }).properties;
    assert.equal(properties?.deviceId, undefined);
    assert.equal(properties?.workspaceId, undefined);
  }
  const commandOutput = byName.get("run_command")?.outputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.equal(commandOutput.properties?.deviceId, undefined);

  const beforeSelection = tools.map((tool) => tool.name).sort();
  const offline = await client.callTool({
    name: "list_workspaces",
    arguments: {},
  });
  assert.deepEqual(offline.structuredContent, {
    product: {
      name: "Glossa",
      description: "The local bridge between ChatGPT and one explicitly exposed workspace.",
      contractVersion: MCP_SERVER_VERSION,
    },
    documentationUrl: "https://glossa.sh/docs/quickstart",
    workspaces: [],
    availability: "offline",
    message: "No Glossa workspaces are online. Ask the user to open a terminal in the workspace they want to expose and run `glossa`. Keep that terminal open, wait for the workspace to appear, then retry. See https://glossa.sh/docs/quickstart for setup help.",
  });
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    beforeSelection,
  );
});

test("binds sessions and fallback tokens without later workspace ids", async (context) => {
  const state = new RouterState();
  const bindings = new BindingState();
  const workers = registerWorkspaces(state);
  const client = await connect(context, state, bindings);

  const unbound = await client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt" },
  });
  assert.equal(errorCode(unbound), "workspace_selection_required");
  assert.equal(
    await state.poll(
      accountId,
      deviceId,
      alphaWorkerId,
      workers.alpha.generation,
      1,
    ),
    null,
  );

  const sessionA = { "openai/session": "conversation-a" };
  const sessionB = { "openai/session": "conversation-b" };
  await client.callTool({
    name: "select_workspace",
    arguments: { workspaceId: alphaWorkspaceId },
    _meta: sessionA,
  });
  const alphaRead = client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt" },
    _meta: sessionA,
  });
  await answerRead(state, alphaWorkerId, workers.alpha.generation, "alpha");
  assert.equal(
    structured<{ content: string }>(await alphaRead).content,
    "alpha",
  );

  await client.callTool({
    name: "select_workspace",
    arguments: { workspaceId: betaWorkspaceId },
    _meta: sessionA,
  });
  await client.callTool({
    name: "select_workspace",
    arguments: { workspaceId: betaWorkspaceId },
    _meta: sessionB,
  });
  const listed = await client.callTool({
    name: "list_workspaces",
    arguments: {},
    _meta: sessionA,
  });
  const workspaces = structured<{ workspaces: Array<{
    workspaceId: string;
    activeAgentBindings: number;
  }> }>(listed).workspaces;
  assert.equal(
    workspaces.find((workspace) => workspace.workspaceId === alphaWorkspaceId)
      ?.activeAgentBindings,
    0,
  );
  assert.equal(
    workspaces.find((workspace) => workspace.workspaceId === betaWorkspaceId)
      ?.activeAgentBindings,
    2,
  );

  const betaRead = client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt" },
    _meta: sessionA,
  });
  await answerRead(state, betaWorkerId, workers.beta.generation, "beta");
  assert.equal(structured<{ content: string }>(await betaRead).content, "beta");

  const fallback = await client.callTool({
    name: "select_workspace",
    arguments: { workspaceId: alphaWorkspaceId },
  });
  const bindingToken = structured<{ bindingToken: string }>(fallback).bindingToken;
  assert.match(String(bindingToken), /^glt_[A-Za-z0-9_-]{43}$/);
  const tokenRead = client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt", bindingToken },
  });
  await answerRead(state, alphaWorkerId, workers.alpha.generation, "token-alpha");
  assert.equal(
    structured<{ content: string }>(await tokenRead).content,
    "token-alpha",
  );

  const otherClient = await connect(context, state, bindings, otherAccountId);
  const stolen = await otherClient.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt", bindingToken },
  });
  assert.equal(errorCode(stolen), "binding_invalid");
});

test("expires bindings and preserves selection across worker return", async (context) => {
  let now = 1_000;
  const state = new RouterState();
  const bindings = new BindingState(100, () => now);
  const first = state.register(
    accountId,
    deviceId,
    "Test PC",
    alphaWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      workspaceId: alphaWorkspaceId,
      rootPath: "C:\\code\\alpha",
    },
  );
  const client = await connect(context, state, bindings);
  const metadata = { "openai/session": "conversation" };
  await client.callTool({
    name: "select_workspace",
    arguments: { workspaceId: alphaWorkspaceId },
    _meta: metadata,
  });

  const returningWorkerId = "00000000-0000-4000-8000-000000000008";
  const returned = state.register(
    accountId,
    deviceId,
    "Test PC",
    returningWorkerId,
    {
      commandProgress: true,
      concurrentJobs: true,
      structuredReads: true,
      workspaceId: alphaWorkspaceId,
      rootPath: "C:\\code\\alpha",
    },
  );
  assert.notEqual(first.generation, returned.generation);
  const restoredRead = client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt" },
    _meta: metadata,
  });
  await answerRead(state, returningWorkerId, returned.generation, "returned");
  assert.equal(
    structured<{ content: string }>(await restoredRead).content,
    "returned",
  );

  now = 1_101;
  const expired = await client.callTool({
    name: "read_file",
    arguments: { path: "sentinel.txt" },
    _meta: metadata,
  });
  assert.equal(errorCode(expired), "workspace_selection_required");
});
