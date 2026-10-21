import assert from "node:assert/strict";
import test from "node:test";
import { routedError } from "./mcp-results.js";

test("explains relay capacity errors to MCP clients", () => {
  for (const code of ["worker_busy", "relay_at_capacity"]) {
    const result = routedError(new Error(code));
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, code);
    assert.match(parsed.error.message, /retry/i);
  }
});
