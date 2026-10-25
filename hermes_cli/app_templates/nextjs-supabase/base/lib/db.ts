import { Pool } from "pg";
import { secret } from "./env";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const pools = new Map<string, Pool>();

function pool(url: string): Pool {
  let current = pools.get(url);
  if (!current) {
    current = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    // An idle client dying (database restart, network blip) must not crash the
    // process; pg drops the broken client and the next query reconnects.
    current.on("error", (err) => console.error("db pool error:", err.message));
    pools.set(url, current);
  }
  return current;
}

/** The app's read-write database, or null when the app has none configured. */
export function db(): Pool | null {
  const url = secret("DATABASE_URL");
  return url ? pool(url) : null;
}

/** The read-only role (falls back to the read-write DSN; callers still use a READ ONLY transaction). */
export function readOnlyDb(): Pool | null {
  const url = secret("DATABASE_URL_RO") ?? secret("DATABASE_URL");
  return url ? pool(url) : null;
}
