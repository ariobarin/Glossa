import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus } from "./status-display.js";

const status = {
  account: "dev@example.com",
  relay: "connected",
  devices: [],
};

test("status gives a next step when no workspaces are active", () => {
  assert.deepEqual(formatStatus({ ...status, activeWorkers: 0 }), [
    "Signed in as dev@example.com.",
    "Relay connected: connected",
    "No active workspaces. Run glossa from the project folder you want to expose.",
    "No devices enrolled.",
  ]);
});

test("status keeps an unavailable worker count distinct", () => {
  assert.match(
    formatStatus({ ...status, activeWorkers: null }).join("\n"),
    /Active workspaces: unavailable/,
  );
});
