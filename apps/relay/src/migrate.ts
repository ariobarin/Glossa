import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { databaseOptions } from "./database-options.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, "../../sql");
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => file.endsWith(".sql"))
  .sort();

const pool = new Pool({
  ...databaseOptions(databaseUrl),
  max: 1,
});

try {
  for (const file of migrationFiles) {
    const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
    await pool.query(sql);
    console.log(`Applied migration ${file}.`);
  }
  console.log("Glossa database migration complete.");
} finally {
  await pool.end();
}
