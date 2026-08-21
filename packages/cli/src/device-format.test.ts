import assert from "node:assert/strict";
import test from "node:test";
import type { RelayDevice } from "./relay-client.js";
import { deviceStatus, formatDeviceRow, formatRelativeTime } from "./device-format.js";

const base: RelayDevice = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test PC",
  platform: "win32-x64",
  lastSeenAt: null,
  revokedAt: null,
  activeWorkers: 0,
};

const now = Date.parse("2026-07-21T12:00:00.000Z");

test("formatRelativeTime handles missing, malformed, and real timestamps", () => {
  assert.equal(formatRelativeTime(null, now), "never");
  assert.equal(formatRelativeTime("garbage", now), "unknown");
  assert.equal(formatRelativeTime("2026-07-21T11:59:35.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-07-21T11:55:00.000Z", now), "5m ago");
  assert.equal(formatRelativeTime("2026-07-21T09:00:00.000Z", now), "3h ago");
  assert.equal(formatRelativeTime("2026-07-18T12:00:00.000Z", now), "3d ago");
});

test("deviceStatus describes revoked, offline, active, and unknown counts", () => {
  assert.equal(deviceStatus({ ...base, revokedAt: "2026-07-01T00:00:00.000Z" }), "revoked");
  assert.equal(deviceStatus({ ...base, activeWorkers: 0 }), "offline");
  assert.equal(deviceStatus({ ...base, activeWorkers: 1 }), "1 active workspace");
  assert.equal(deviceStatus({ ...base, activeWorkers: 3 }), "3 active workspaces");
  assert.equal(deviceStatus({ ...base, activeWorkers: null }), "workspace count unavailable");
});

test("formatDeviceRow includes id, name, platform, last seen, and status", () => {
  const row = formatDeviceRow(
    { ...base, lastSeenAt: "2026-07-21T09:00:00.000Z", activeWorkers: 1 },
    now,
  );
  assert.ok(row.includes(base.id));
  assert.ok(row.includes("Test PC"));
  assert.ok(row.includes("win32-x64"));
  assert.ok(row.includes("last seen 3h ago"));
  assert.ok(row.includes("1 active workspace"));
});

test("formatDeviceRow falls back to an unknown platform label", () => {
  const row = formatDeviceRow({ ...base, platform: null }, now);
  assert.ok(row.includes("unknown platform"));
});
