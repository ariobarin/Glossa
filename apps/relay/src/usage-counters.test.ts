import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, type LogRecord } from "./log.js";
import {
  UsageCounters,
  writeUsageRows,
  type UsageRow,
} from "./usage-counters.js";

function counters(options: {
  write?: (rows: UsageRow[]) => Promise<void>;
  online?: { workers: number; accounts: number };
  now?: () => number;
} = {}) {
  const records: LogRecord[] = [];
  const written: UsageRow[][] = [];
  let online = options.online ?? { workers: 0, accounts: 0 };
  const usage = new UsageCounters({
    write: options.write ?? (async (rows) => {
      written.push(rows);
    }),
    online: () => online,
    log: createLogger((record) => records.push(record)),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    usage,
    records,
    written,
    setOnline: (value: typeof online) => {
      online = value;
    },
  };
}

const day = Date.parse("2026-10-21T12:00:00Z");

test("sums counters and keeps peaks per UTC day", async () => {
  let now = day;
  const { usage, written, setOnline } = counters({ now: () => now });
  usage.increment("mcp_requests");
  usage.increment("mcp_requests");
  usage.increment("tool_calls", 3);
  setOnline({ workers: 7, accounts: 4 });
  usage.sampleOnline();
  setOnline({ workers: 2, accounts: 1 });
  now = Date.parse("2026-10-22T00:00:01Z");
  usage.increment("pairings_redeemed");

  await usage.flush();
  const rows = written[0]!.map((row) => `${row.day} ${row.metric} ${row.value}`).sort();
  assert.deepEqual(rows, [
    "2026-10-21 mcp_requests 2",
    "2026-10-21 peak_accounts_online 4",
    "2026-10-21 peak_workers_online 7",
    "2026-10-21 tool_calls 3",
    "2026-10-22 pairings_redeemed 1",
    "2026-10-22 peak_accounts_online 1",
    "2026-10-22 peak_workers_online 2",
  ]);

  // Pending rows are cleared once written.
  now = Date.parse("2026-10-22T00:00:02Z");
  await usage.flush();
  assert.deepEqual(
    written[1]!.map((row) => row.metric).sort(),
    ["peak_accounts_online", "peak_workers_online"],
  );
});

test("keeps rows after a failed flush and logs a warning", async () => {
  let fail = true;
  const attempts: UsageRow[][] = [];
  const { usage, records } = counters({
    now: () => day,
    write: async (rows) => {
      attempts.push(rows);
      if (fail) throw new Error("connection refused for postgres://user:secret@db");
    },
  });
  usage.increment("worker_registrations", 2);
  await usage.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.event, "usage_flush_failed");
  assert.doesNotMatch(JSON.stringify(records), /secret/);

  usage.increment("worker_registrations");
  fail = false;
  await usage.flush();
  const retried = attempts[1]!.find((row) => row.metric === "worker_registrations");
  assert.equal(retried?.value, 3);
});

test("reports a five-minute usage line and resets its window", () => {
  const { usage, records } = counters({ online: { workers: 3, accounts: 2 } });
  usage.increment("mcp_requests", 5);
  usage.report();
  usage.report();
  assert.deepEqual(records, [
    { level: "info", event: "relay_usage", workersOnline: 3, accountsOnline: 2, mcpRequests5m: 5 },
    { level: "info", event: "relay_usage", workersOnline: 3, accountsOnline: 2, mcpRequests5m: 0 },
  ]);
});

test("upserts sums and peaks in one statement", async () => {
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  await writeUsageRows({
    async query(sql, values) {
      queries.push({ sql, values });
      return {};
    },
  }, [
    { day: "2026-10-21", metric: "mcp_requests", value: 4 },
    { day: "2026-10-21", metric: "peak_workers_online", value: 9 },
  ]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /ON CONFLICT \(day, metric\)/);
  assert.match(queries[0]!.sql, /GREATEST/);
  assert.deepEqual(queries[0]!.values, [
    ["2026-10-21", "2026-10-21"],
    ["mcp_requests", "peak_workers_online"],
    [4, 9],
  ]);
  await writeUsageRows({
    async query() {
      throw new Error("no rows should skip the query");
    },
  }, []);
});
