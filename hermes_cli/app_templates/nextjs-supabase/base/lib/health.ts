import { APP_NAME, HOSTING, appMode } from "@/app.config.mjs";
import pkg from "@/package.json";
import type { Queryable } from "./db";

export interface HealthReport {
  ok: boolean;
  name: string;
  version: string;
  hosting: string;
  mode: "dev" | "prod";
  db: "ok" | "error" | "none";
  migration: string | null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function latestMigration(database: Queryable): Promise<string | null> {
  const present = await database.query(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present",
  );
  if (!present.rows[0]?.present) return null;
  const latest = await database.query("select max(version)::text as version from supabase_migrations.schema_migrations");
  return (latest.rows[0]?.version as string | null) ?? null;
}

/** Health facts only: never a secret, DSN or error message. */
export async function healthReport(
  database: Queryable | null,
  { timeoutMs = 1000, env = process.env }: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<HealthReport> {
  let status: HealthReport["db"] = "none";
  let migration: string | null = null;
  if (database) {
    try {
      await withTimeout(database.query("select 1"), timeoutMs);
      status = "ok";
      migration = await withTimeout(latestMigration(database), timeoutMs).catch(() => null);
    } catch {
      status = "error";
    }
  }
  return {
    ok: status !== "error",
    name: APP_NAME,
    version: pkg.version,
    hosting: HOSTING,
    mode: appMode(env),
    db: status,
    migration,
  };
}
