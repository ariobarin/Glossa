import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createLogger, safeErrorFields, type LogRecord } from "./log.js";
import { requestErrorHandler } from "./request-errors.js";

const SECRET_CONTENT = "file-contents-that-must-not-be-logged";

test("writes one record per event and never throws", () => {
  const records: LogRecord[] = [];
  const log = createLogger((record) => records.push(record));
  log("warn", "relay_security_event", { surface: "mcp_oauth", unset: undefined });
  assert.deepEqual(records, [
    { level: "warn", event: "relay_security_event", surface: "mcp_oauth", unset: undefined },
  ]);
  assert.equal(
    JSON.stringify(records[0]),
    '{"surface":"mcp_oauth","level":"warn","event":"relay_security_event"}',
  );
  const failing = createLogger(() => {
    throw new Error("sink failed");
  });
  assert.doesNotThrow(() => failing("info", "relay_usage"));
});

test("describes errors without their message text", () => {
  const error = Object.assign(
    new SyntaxError(`Unexpected token in "${SECRET_CONTENT}\n    at fake (${SECRET_CONTENT})"`),
    { code: "ERR_TEST", type: "entity.parse.failed" },
  );
  const fields = safeErrorFields(error);
  assert.equal(fields.errorName, "SyntaxError");
  assert.equal(fields.errorCode, "ERR_TEST");
  assert.equal(fields.errorType, "entity.parse.failed");
  assert.ok(Array.isArray(fields.stack) && fields.stack.length > 0);
  assert.ok((fields.stack as string[]).every((frame) => frame.startsWith("at ")));
  assert.doesNotMatch(JSON.stringify(fields), new RegExp(SECRET_CONTENT));

  const unsafeCode = safeErrorFields(Object.assign(new Error("x"), { code: SECRET_CONTENT + " " }));
  assert.equal(unsafeCode.errorCode, undefined);
  assert.deepEqual(safeErrorFields("string rejection"), { errorName: "string" });
});

test("logs request errors by route pattern and hides details from clients", async (context) => {
  const records: LogRecord[] = [];
  const log = createLogger((record) => records.push(record));
  const app = express();
  app.use(express.json());
  app.post("/device/:deviceId/fail", () => {
    throw new Error(SECRET_CONTENT);
  });
  app.post("/device/ok", (_request, response) => {
    response.json({ ok: true });
  });
  app.use(requestErrorHandler(log));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const failed = await fetch(`${origin}/device/device-1234/fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "internal_error" });

  const malformed = await fetch(`${origin}/device/ok`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"content": ${SECRET_CONTENT}}`,
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_request" });

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map(({ level, event, method, route, status, errorName }) =>
      ({ level, event, method, route, status, errorName })),
    [
      {
        level: "error",
        event: "request_error",
        method: "POST",
        route: "/device/:deviceId/fail",
        status: 500,
        errorName: "Error",
      },
      {
        level: "warn",
        event: "request_error",
        method: "POST",
        route: "unmatched",
        status: 400,
        errorName: "SyntaxError",
      },
    ],
  );
  assert.equal(records[1]!.errorType, "entity.parse.failed");
  const logged = JSON.stringify(records);
  assert.doesNotMatch(logged, new RegExp(SECRET_CONTENT));
  assert.doesNotMatch(logged, /device-1234/);
});
