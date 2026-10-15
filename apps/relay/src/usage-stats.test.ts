import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStats, usageStats, type Queryable } from "./usage-stats.js";

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
  assert.equal(calls.length, 2);
  for (const call of calls) {
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
});

test("shows when an excluded subject matched no account", async () => {
  const { db } = fixture();
  const stats = await usageStats(db, ["google-oauth2|typo"]);
  const text = formatUsageStats({ ...stats, excludedAccounts: 0 });
  assert.match(text, /^Glossa usage \(excluding 0 accounts matched by 1 subject\)/);
});
