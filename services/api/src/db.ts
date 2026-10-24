import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('schema_migrations'))");
    try {
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      let migrationsDir = path.resolve(process.cwd(), "migrations");
      let migrationFiles: string[];
      try {
        migrationFiles = await readdir(migrationsDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        migrationsDir = path.resolve(process.cwd(), "src", "migrations");
        migrationFiles = await readdir(migrationsDir);
      }
      const files = migrationFiles.filter((file) => file.endsWith(".sql")).sort();
      for (const file of files) {
        const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if (alreadyApplied.rowCount) continue;
        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [file]);
          await client.query("COMMIT");
          console.info(`Applied migration ${file}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('schema_migrations'))");
    }
  } finally {
    client.release();
  }
}

export async function databaseIsReady() {
  await pool.query("SELECT 1");
  return true;
}

export { pool };
