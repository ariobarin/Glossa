import { Pool } from "pg";
import { databaseOptions } from "./database-options.js";
import { formatUsageStats, usageStats } from "./usage-stats.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const args = process.argv.slice(2);
const json = args.includes("--json");
const excludeSubjects = (process.env.GLOSSA_STATS_EXCLUDE_SUBJECTS ?? "").split(",");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exclude-subject") {
    const subject = args[i + 1];
    if (!subject) throw new Error("--exclude-subject needs an Auth0 subject.");
    excludeSubjects.push(subject);
    i++;
  }
}

const pool = new Pool({ ...databaseOptions(databaseUrl), max: 1 });
try {
  const stats = await usageStats(pool, excludeSubjects);
  console.log(json ? JSON.stringify(stats, null, 2) : formatUsageStats(stats));
} finally {
  await pool.end();
}
