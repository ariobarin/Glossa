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
  "logout",
  "read_file",
  "run_command",
  "write_file",
];

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

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GLOSSA_PUBLIC_ORIGIN: "https://mcp.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://mcp.glossa.test/",
  });
}

test("publishes reviewable MCP tool contracts", async (context) => {
  const server = createMcpServer(
    testConfig(),
    new RouterState(),
    "00000000-0000-4000-8000-000000000001",
  );
  const client = new Client({ name: "glossa-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  context.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  assert.equal(client.getServerVersion()?.version, MCP_SERVER_VERSION);
  assert.notEqual(client.getServerVersion()?.version, "0.0.0");

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

  const commandOutputSchema = byName.get("get_command")?.outputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(commandOutputSchema.properties?.commandId);
  assert.ok(commandOutputSchema.properties?.status);
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
    devices: [],
    availability: "offline",
    message: "No Glossa workspaces are online. Start Glossa in the workspace you want to expose, then try again.",
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: JSON.stringify({
        devices: [],
        availability: "offline",
        message: "No Glossa workspaces are online. Start Glossa in the workspace you want to expose, then try again.",
      }),
    },
  ]);

  const logout = await client.callTool({
    name: "logout",
    arguments: {},
  });
  const logoutUrl = "https://identity.glossa.test/v2/logout";
  assert.equal(logout.isError, undefined);
  assert.deepEqual(logout.structuredContent, {
    logoutUrl,
    instructions: `In the Glossa terminal, press l and confirm, or run glossa logout. Stop any other Glossa sessions with q or Ctrl+C. If the CLI does not open a browser, open ${logoutUrl}. Then disconnect and reconnect Glossa in ChatGPT. The CLI starts Google login automatically the next time it needs an account. Choose the same intended Google account for both authorizations.`,
  });
});
