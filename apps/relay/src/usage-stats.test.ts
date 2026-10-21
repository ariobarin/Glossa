import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsageStats,
  npmDownloads,
  usageStats,
  type Queryable,
} from "./usage-stats.js";

function fixture(): { db: Queryable; calls: { sql: string; values: unknown[] }[] } {
  const calls: { sql: string; values: unknown[] }[] = [];
  const results: unknown[][] = [
    [
      {
        excluded_accounts: 1,
        accounts: 12,
        admitted_accounts: 9,
        new_accounts_7d: 2,
        new_accounts_30d: 5,
        devices_enrolled: 15,
        devices_active: 11,
        devices_seen_7d: 7,
        accounts_seen_1d: 3,
        accounts_seen_7d: 6,
        accounts_seen_30d: 8,
      },
    ],
    [
      { platform: "win32", devices: 6 },
      { platform: "darwin", devices: 5 },
    ],
    [
      {
        day: "2026-10-21",
        mcp_requests: 1200,
        tool_calls: 800,
        pairings: 4,
        worker_registrations: 30,
        peak_workers_online: 9,
        peak_accounts_online: 6,
      },
    ],
  ];
  const db = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const rows = results.shift();
      if (!rows) throw new Error("Unexpected query.");
      return { rows };
    },
  } as unknown as Queryable;
  return { db, calls };
}

test("excludes subjects by parameter and reports only counts", async () => {
  const { db, calls } = fixture();
  const stats = await usageStats(db, [" google-oauth2|me ", "", "google-oauth2|me"]);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.deepEqual(call.values, [["google-oauth2|me"]]);
    assert.doesNotMatch(call.sql, /token_|\bname\b|auth0_subject\s*,/);
  }
  assert.equal(stats.excludedSubjects, 1);
  assert.equal(stats.excludedAccounts, 1);
  assert.equal(stats.accountsSeen7d, 6);
  assert.deepEqual(stats.platforms, [
    { platform: "win32", devices: 6 },
    { platform: "darwin", devices: 5 },
  ]);
});

test("formats a readable summary", async () => {
  const { db } = fixture();
  const text = formatUsageStats(await usageStats(db));
  assert.match(text, /^Glossa usage \(all accounts\)/);
  assert.match(text, /Accounts\s+12 signed up, 9 admitted/);
  assert.match(text, /Active accounts\s+3 in the last 24 hours, 6 in 7 days, 8 in 30 days/);
  assert.match(text, /Platforms\s+win32 6, darwin 5/);
  assert.doesNotMatch(text, /npm downloads/);
  assert.match(text, /2026-10-21\s+1200\s+800\s+4\s+30\s+9\s+6/);
});

test("reads daily counters as aggregate numbers only", async () => {
  const { db, calls } = fixture();
  const stats = await usageStats(db);
  assert.match(calls[2]!.sql, /FROM usage_daily/);
  assert.deepEqual(stats.daily, [{
    day: "2026-10-21",
    mcpRequests: 1200,
    toolCalls: 800,
    pairings: 4,
    workerRegistrations: 30,
    peakWorkersOnline: 9,
    peakAccountsOnline: 6,
  }]);
});

test("reports npm downloads and tolerates an unreachable registry", async () => {
  const counts: Record<string, number> = {
    "last-day": 5,
    "last-week": 40,
    "last-month": 90,
  };
  const requested: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const href = String(url);
    requested.push(href);
    const period = href.split("/")[5]!;
    return new Response(JSON.stringify({ downloads: counts[period] }));
  }) as typeof fetch;
  const npm = await npmDownloads(fetcher);
  assert.deepEqual(npm, { lastDay: 5, lastWeek: 40, lastMonth: 90 });
  assert.ok(requested.every((href) =>
    href.startsWith("https://api.npmjs.org/downloads/point/") &&
    href.endsWith("/@ariobarin/glossa")));

  const { db } = fixture();
  const stats = await usageStats(db);
  assert.match(
    formatUsageStats(stats, npm),
    /npm downloads\s+5 in the last day, 40 in 7 days, 90 in 30 days/,
  );

  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await npmDownloads(offline), null);
  assert.match(formatUsageStats(stats, null), /npm downloads\s+unavailable/);
});

test("shows when an excluded subject matched no account", async () => {
  const { db } = fixture();
  const stats = await usageStats(db, ["google-oauth2|typo"]);
  const text = formatUsageStats({ ...stats, excludedAccounts: 0 });
  assert.match(text, /^Glossa usage \(excluding 0 accounts matched by 1 subject\)/);
});
