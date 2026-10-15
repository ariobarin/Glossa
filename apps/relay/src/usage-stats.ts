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
  };
}

export function formatUsageStats(stats: UsageStats): string {
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
  ].join("\n");
}
