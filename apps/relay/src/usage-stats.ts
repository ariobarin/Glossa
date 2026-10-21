export interface Queryable {
  query<Row>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface UsageStats {
  excludedSubjects: number;
  excludedAccounts: number;
  accounts: number;
  admittedAccounts: number;
  newAccounts7d: number;
  newAccounts30d: number;
  devicesEnrolled: number;
  devicesActive: number;
  devicesSeen7d: number;
  accountsSeen1d: number;
  accountsSeen7d: number;
  accountsSeen30d: number;
  platforms: { platform: string; devices: number }[];
  /** Relay-wide daily counters, newest first. Not filtered by subject. */
  daily: DailyUsage[];
}

export interface DailyUsage {
  day: string;
  mcpRequests: number;
  toolCalls: number;
  pairings: number;
  workerRegistrations: number;
  peakWorkersOnline: number;
  peakAccountsOnline: number;
}

export interface NpmDownloads {
  lastDay: number;
  lastWeek: number;
  lastMonth: number;
}

const DAILY_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day,
  coalesce(sum(value) FILTER (WHERE metric = 'mcp_requests'), 0)::int AS mcp_requests,
  coalesce(sum(value) FILTER (WHERE metric = 'tool_calls'), 0)::int AS tool_calls,
  coalesce(sum(value) FILTER (
    WHERE metric IN ('pairings_redeemed', 'device_enrollments')), 0)::int AS pairings,
  coalesce(sum(value) FILTER (WHERE metric = 'worker_registrations'), 0)::int
    AS worker_registrations,
  coalesce(max(value) FILTER (WHERE metric = 'peak_workers_online'), 0)::int
    AS peak_workers_online,
  coalesce(max(value) FILTER (WHERE metric = 'peak_accounts_online'), 0)::int
    AS peak_accounts_online
FROM usage_daily
WHERE day > (now() AT TIME ZONE 'UTC')::date - 7
GROUP BY day
ORDER BY day DESC
`;

interface DailyRow {
  day: string;
  mcp_requests: number;
  tool_calls: number;
  pairings: number;
  worker_registrations: number;
  peak_workers_online: number;
  peak_accounts_online: number;
}

const NPM_PACKAGE = "@ariobarin/glossa";

/** Public npm registry download counts; null when the registry is unreachable. */
export async function npmDownloads(
  fetcher: typeof fetch = fetch,
): Promise<NpmDownloads | null> {
  const period = async (name: string): Promise<number> => {
    const response = await fetcher(
      `https://api.npmjs.org/downloads/point/${name}/${NPM_PACKAGE}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error(`npm returned HTTP ${response.status}`);
    const body = await response.json() as { downloads?: unknown };
    if (typeof body.downloads !== "number") throw new Error("npm returned no count");
    return body.downloads;
  };
  try {
    const [lastDay, lastWeek, lastMonth] = await Promise.all(
      ["last-day", "last-week", "last-month"].map(period),
    );
    return { lastDay: lastDay!, lastWeek: lastWeek!, lastMonth: lastMonth! };
  } catch {
    return null;
  }
}

const COUNTS_SQL = `
WITH included AS (
  SELECT id, created_at, admitted_at, disabled_at
  FROM accounts
  WHERE NOT (auth0_subject = ANY($1::text[]))
),
device_rows AS (
  SELECT d.account_id, d.last_seen_at, d.revoked_at
  FROM devices d
  JOIN included a ON a.id = d.account_id
)
SELECT
  (SELECT count(*) FROM accounts
    WHERE auth0_subject = ANY($1::text[]))::int AS excluded_accounts,
  (SELECT count(*) FROM included)::int AS accounts,
  (SELECT count(*) FROM included
    WHERE admitted_at IS NOT NULL AND disabled_at IS NULL)::int AS admitted_accounts,
  (SELECT count(*) FROM included
    WHERE created_at >= now() - interval '7 days')::int AS new_accounts_7d,
  (SELECT count(*) FROM included
    WHERE created_at >= now() - interval '30 days')::int AS new_accounts_30d,
  (SELECT count(*) FROM device_rows)::int AS devices_enrolled,
  (SELECT count(*) FROM device_rows WHERE revoked_at IS NULL)::int AS devices_active,
  (SELECT count(*) FROM device_rows
    WHERE last_seen_at >= now() - interval '7 days')::int AS devices_seen_7d,
  (SELECT count(DISTINCT account_id) FROM device_rows
    WHERE last_seen_at >= now() - interval '1 day')::int AS accounts_seen_1d,
  (SELECT count(DISTINCT account_id) FROM device_rows
    WHERE last_seen_at >= now() - interval '7 days')::int AS accounts_seen_7d,
  (SELECT count(DISTINCT account_id) FROM device_rows
    WHERE last_seen_at >= now() - interval '30 days')::int AS accounts_seen_30d
`;

const PLATFORMS_SQL = `
SELECT coalesce(d.platform, 'unknown') AS platform, count(*)::int AS devices
FROM devices d
JOIN accounts a ON a.id = d.account_id
WHERE d.revoked_at IS NULL AND NOT (a.auth0_subject = ANY($1::text[]))
GROUP BY 1
ORDER BY 2 DESC, 1
`;

interface CountsRow {
  excluded_accounts: number;
  accounts: number;
  admitted_accounts: number;
  new_accounts_7d: number;
  new_accounts_30d: number;
  devices_enrolled: number;
  devices_active: number;
  devices_seen_7d: number;
  accounts_seen_1d: number;
  accounts_seen_7d: number;
  accounts_seen_30d: number;
}

/** Aggregate counts only. Never reads tokens, names or identifiers back out. */
export async function usageStats(
  db: Queryable,
  excludeSubjects: string[] = [],
): Promise<UsageStats> {
  const subjects = [...new Set(excludeSubjects.map((s) => s.trim()).filter(Boolean))];
  const counts = (await db.query<CountsRow>(COUNTS_SQL, [subjects])).rows[0];
  if (!counts) throw new Error("Usage query returned no rows.");
  const platforms = (
    await db.query<{ platform: string; devices: number }>(PLATFORMS_SQL, [subjects])
  ).rows;
  const daily = (await db.query<DailyRow>(DAILY_SQL)).rows.map((row) => ({
    day: row.day,
    mcpRequests: row.mcp_requests,
    toolCalls: row.tool_calls,
    pairings: row.pairings,
    workerRegistrations: row.worker_registrations,
    peakWorkersOnline: row.peak_workers_online,
    peakAccountsOnline: row.peak_accounts_online,
  }));
  return {
    excludedSubjects: subjects.length,
    excludedAccounts: counts.excluded_accounts,
    accounts: counts.accounts,
    admittedAccounts: counts.admitted_accounts,
    newAccounts7d: counts.new_accounts_7d,
    newAccounts30d: counts.new_accounts_30d,
    devicesEnrolled: counts.devices_enrolled,
    devicesActive: counts.devices_active,
    devicesSeen7d: counts.devices_seen_7d,
    accountsSeen1d: counts.accounts_seen_1d,
    accountsSeen7d: counts.accounts_seen_7d,
    accountsSeen30d: counts.accounts_seen_30d,
    platforms,
    daily,
  };
}

export function formatUsageStats(
  stats: UsageStats,
  npm?: NpmDownloads | null,
): string {
  const platforms = stats.platforms.length
    ? stats.platforms.map((p) => `${p.platform} ${p.devices}`).join(", ")
    : "none";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const excluded =
    stats.excludedSubjects === 0
      ? "all accounts"
      : `excluding ${plural(stats.excludedAccounts, "account")} matched by ${plural(stats.excludedSubjects, "subject")}`;
  return [
    `Glossa usage (${excluded})`,
    `Accounts         ${stats.accounts} signed up, ${stats.admittedAccounts} admitted`,
    `New accounts     ${stats.newAccounts7d} in the last 7 days, ${stats.newAccounts30d} in the last 30`,
    `Active accounts  ${stats.accountsSeen1d} in the last 24 hours, ${stats.accountsSeen7d} in 7 days, ${stats.accountsSeen30d} in 30 days`,
    `Devices          ${stats.devicesEnrolled} enrolled, ${stats.devicesActive} not revoked, ${stats.devicesSeen7d} seen in 7 days`,
    `Platforms        ${platforms}`,
    "An account is active when one of its paired devices connected in that window.",
    ...(npm === undefined
      ? []
      : [
          npm
            ? `npm downloads    ${npm.lastDay} in the last day, ${npm.lastWeek} in 7 days, ${npm.lastMonth} in 30 days`
            : "npm downloads    unavailable (registry unreachable)",
        ]),
    "",
    ...formatDaily(stats.daily),
  ].join("\n");
}

function formatDaily(daily: DailyUsage[]): string[] {
  if (daily.length === 0) return ["Daily relay counts: none recorded yet."];
  const header = ["Day (UTC)", "MCP reqs", "Tool calls", "Pairings", "Workers", "Peak workers", "Peak accounts"];
  const rows = daily.map((day) => [
    day.day,
    day.mcpRequests,
    day.toolCalls,
    day.pairings,
    day.workerRegistrations,
    day.peakWorkersOnline,
    day.peakAccountsOnline,
  ].map(String));
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]) => cells
    .map((cell, column) => column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))
    .join("  ");
  return [
    "Daily relay counts (all accounts; Workers counts worker connections)",
    line(header),
    ...rows.map(line),
  ];
}
