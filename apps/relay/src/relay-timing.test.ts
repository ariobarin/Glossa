import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Request, Response } from "express";
import {
  relayOperation,
  relayTimingMiddleware,
  type RelayTimingEvent,
} from "./relay-timing.js";

test("classifies only bounded relay metadata", () => {
  assert.equal(relayOperation({ path: "/mcp", body: {
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "secret.txt" } },
  } } as Request), "mcp:read_file");
  assert.equal(relayOperation({ path: "/mcp", body: {
    method: "tools/call",
    params: { name: "user-controlled-value" },
  } } as Request), "mcp:tools/call");
  assert.equal(
    relayOperation({ path: "/v1/devices/00000000-0000-4000-8000-000000000001", body: {} } as Request),
    "http:/v1/devices/:deviceId",
  );
  assert.equal(
    relayOperation({ path: "/v1/devices", body: {} } as Request),
    "http:/v1/devices",
  );
  assert.equal(relayOperation({ path: "/unknown/private/path", body: {} } as Request), "http:other");
});

test("records status and duration when a response finishes", async () => {
  const events: RelayTimingEvent[] = [];
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = 202;
  const request = { path: "/device/result", body: {} } as Request;
  let nextCalled = false;

  relayTimingMiddleware((event) => events.push(event))(
    request,
    response,
    () => { nextCalled = true; },
  );
  response.emit("finish");

  assert.equal(nextCalled, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: "relay_request_timing",
    operation: "http:/device/result",
    status: 202,
    durationMs: events[0]!.durationMs,
  });
  assert.ok(events[0]!.durationMs >= 0);
  assert.deepEqual(Object.keys(events[0]!).sort(), [
    "durationMs",
    "event",
    "operation",
    "status",
  ]);
});


test("ignores timing sink failures", () => {
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = 200;
  relayTimingMiddleware(() => {
    throw new Error("metrics backend unavailable");
  })(
    { path: "/healthz", body: {} } as Request,
    response,
    () => {},
  );
  assert.doesNotThrow(() => response.emit("finish"));
});
