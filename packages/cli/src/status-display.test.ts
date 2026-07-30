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
    "No active devices.",
  ]);
});

test("status keeps an unavailable worker count distinct", () => {
  assert.match(
    formatStatus({ ...status, activeWorkers: null }).join("\n"),
    /Active workspaces: unavailable/,
  );
});

test("status formats device recency against the current time", () => {
  const lines = formatStatus({
    ...status,
    activeWorkers: 0,
    devices: [{
      id: "device-1",
      name: "Laptop",
      platform: "Windows",
      lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      revokedAt: null,
      activeWorkers: 0,
    }],
  });
  assert.match(lines.join("\n"), /last seen 10m ago/);
});
