import { log as defaultLog, safeErrorFields, type Logger } from "./log.js";

export type CounterMetric =
  | "mcp_requests"
  | "tool_calls"
  | "pairings_redeemed"
  | "device_enrollments"
  | "worker_registrations";

export type PeakMetric = "peak_workers_online" | "peak_accounts_online";

export type UsageMetric = CounterMetric | PeakMetric;

export interface UsageRow {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  metric: UsageMetric;
  value: number;
}

export interface UsageRecorder {
  increment(metric: CounterMetric, by?: number): void;
}

export interface OnlineTotals {
  workers: number;
  accounts: number;
}

export type UsageWriter = (rows: UsageRow[]) => Promise<void>;

const UPSERT_USAGE_SQL = `
INSERT INTO usage_daily (day, metric, value)
SELECT * FROM unnest($1::date[], $2::text[], $3::bigint[])
ON CONFLICT (day, metric) DO UPDATE SET value = CASE
  WHEN usage_daily.metric LIKE 'peak\\_%' THEN GREATEST(usage_daily.value, EXCLUDED.value)
  ELSE usage_daily.value + EXCLUDED.value
END
`;

export interface UsageQueryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/** Adds counters and raises peaks for each pending day and metric. */
export async function writeUsageRows(
  db: UsageQueryable,
  rows: UsageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.query(UPSERT_USAGE_SQL, [
    rows.map((row) => row.day),
    rows.map((row) => row.metric),
    rows.map((row) => row.value),
  ]);
}

function isPeak(metric: UsageMetric): metric is PeakMetric {
  return metric.startsWith("peak_");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Aggregate daily counts only. Nothing here is keyed by account, device,
 * worker, tool argument, or path; a row is a day, a fixed metric name, and a
 * number.
 */
export class UsageCounters implements UsageRecorder {
  readonly #pending = new Map<string, UsageRow>();
  readonly #write: UsageWriter;
  readonly #online: () => OnlineTotals;
  readonly #log: Logger;
  readonly #now: () => number;
  #mcpRequestsSinceReport = 0;
  #flushing: Promise<void> | undefined;
  #timers: NodeJS.Timeout[] = [];

  constructor(options: {
    write: UsageWriter;
    online: () => OnlineTotals;
    log?: Logger;
    now?: () => number;
  }) {
    this.#write = options.write;
    this.#online = options.online;
    this.#log = options.log ?? defaultLog;
    this.#now = options.now ?? Date.now;
  }

  increment(metric: CounterMetric, by = 1): void {
    if (metric === "mcp_requests") this.#mcpRequestsSinceReport += by;
    this.#merge({ day: utcDay(this.#now()), metric, value: by });
  }

  /** Records the current online totals as candidate daily peaks. */
  sampleOnline(): OnlineTotals {
    const totals = this.#online();
    const day = utcDay(this.#now());
    this.#merge({ day, metric: "peak_workers_online", value: totals.workers });
    this.#merge({ day, metric: "peak_accounts_online", value: totals.accounts });
    return totals;
  }

  /** Writes pending rows. A failed write keeps them for the next attempt. */
  async flush(): Promise<void> {
    if (this.#flushing) return await this.#flushing;
    this.sampleOnline();
    const rows = [...this.#pending.values()];
    if (rows.length === 0) return;
    this.#pending.clear();
    this.#flushing = (async () => {
      try {
        await this.#write(rows);
      } catch (error) {
        for (const row of rows) this.#merge(row);
        this.#log("warn", "usage_flush_failed", {
          rows: rows.length,
          ...safeErrorFields(error),
        });
      } finally {
        this.#flushing = undefined;
      }
    })();
    await this.#flushing;
  }

  /** Logs a five-minute summary line. */
  report(): void {
    const totals = this.sampleOnline();
    this.#log("info", "relay_usage", {
      workersOnline: totals.workers,
      accountsOnline: totals.accounts,
      mcpRequests5m: this.#mcpRequestsSinceReport,
    });
    this.#mcpRequestsSinceReport = 0;
  }

  start(flushMs = 60_000, reportMs = 5 * 60_000): void {
    this.stop();
    const flush = setInterval(() => void this.flush(), flushMs);
    const report = setInterval(() => this.report(), reportMs);
    flush.unref();
    report.unref();
    this.#timers = [flush, report];
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }

  #merge(row: UsageRow): void {
    const key = `${row.day}|${row.metric}`;
    const current = this.#pending.get(key);
    if (!current) {
      this.#pending.set(key, { ...row });
      return;
    }
    current.value = isPeak(row.metric)
      ? Math.max(current.value, row.value)
      : current.value + row.value;
  }
}
