import { APP_NAME, HOSTING, TEMPLATE_VERSION, appMode } from "@/app.config.mjs";
import pkg from "@/package.json";
import type { QueryConfig } from "pg";
import { db, readOnlyDb } from "../db";
import { healthReport } from "../health";
import type { McpTool } from "./server.mjs";

const MAX_ROWS = 200;
const MAX_CHARS = 20_000;

function capped(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (truncated)` : text;
}

async function readOnly<T>(work: (run: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) {
  const pool = readOnlyDb();
  if (!pool) throw new Error("this app has no database");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '2s'");
    // queryMode "extended" sends one statement per call, so "COMMIT; …"
    // cannot escape the read-only transaction.
    return await work(async (sql, values = []) => {
      const config = { text: sql, values, queryMode: "extended" };
      return (await client.query(config as QueryConfig)).rows;
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * The standard tool set every app starts with. Add app-specific mutations as
 * `action_<verb>` tools with `annotations: { destructiveHint: true }`;
 * Aquarium asks the user before running them.
 */
export const appTools: McpTool[] = [
  {
    name: "app_info",
    description: `Name, version, hosting and mode of the ${APP_NAME} app.`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: () => ({
      name: APP_NAME,
      version: pkg.version,
      hosting: HOSTING,
      mode: appMode(),
      template_version: TEMPLATE_VERSION,
    }),
  },
  {
    name: "app_health",
    description: "Health of the app and its database connection.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: () => healthReport(db()),
  },
  {
    name: "data_schema",
    description: "Tables and columns in the app's public schema (read-only).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    handler: () =>
      readOnly(async (run) =>
        capped(
          await run(
            "select table_name, column_name, data_type from information_schema.columns " +
              "where table_schema = 'public' order by table_name, ordinal_position",
          ),
        ),
      ),
  },
  {
    name: "data_query",
    description: `Run one read-only SQL query against the app's database (at most ${MAX_ROWS} rows).`,
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "A single SELECT statement." } },
      required: ["sql"],
    },
    annotations: { readOnlyHint: true },
    handler: (args) => {
      const sql = typeof args.sql === "string" ? args.sql.trim() : "";
      if (!sql) throw new Error("sql is required");
      return readOnly(async (run) => capped((await run(sql)).slice(0, MAX_ROWS)));
    },
  },
];
