/** Data dictionary (plan 2026-11-14-001): Supabase data sources and what their tables mean. */

export type DataAccess = "read" | "propose" | "manage";
export type DataGrantLevel = "read" | "propose";
export type DictionaryStatus = "approved" | "draft" | "not_described";

export interface SchemaDriftItem {
  table: string;
  change: "added" | "removed" | "columns";
  detail?: { columns?: string[]; added?: string[]; removed?: string[] };
}

export interface DataSource {
  id: string;
  kind: "app" | "site";
  name: string;
  owner_user_id: string;
  site_id: string | null;
  access: DataAccess;
  status?: DictionaryStatus;
  approved_version?: number | null;
  approved_at?: string | null;
  tables_described?: number;
  draft_version?: number | null;
  draft_changes?: number;
  schema_checked_at?: string | null;
  schema_drift?: SchemaDriftItem[];
}

export interface DictionaryEntry {
  meaning: string;
  row: string;
  grain: string;
  /** Set when the schema check found this table no longer matches the dictionary. */
  stale?: boolean;
  columns: Record<string, string>;
  joins: { to: string; on: string; note: string }[];
  metrics: { name: string; definition: string; sql: string }[];
  examples: { question: string; sql: string }[];
}

export interface DictionaryEntries {
  tables: Record<string, DictionaryEntry>;
  glossary: { term: string; definition: string }[];
}

export interface DictionaryChange {
  table: string;
  origin: string;
  by: string;
  note: string;
}

export interface DictionaryVersion {
  version: number;
  status: "draft" | "approved" | "superseded" | "rejected";
  based_on: number | null;
  changes: DictionaryChange[];
  proposed_by: string;
  proposed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  entries?: DictionaryEntries;
  changed_tables?: string[];
}

export interface DataSourceDoc {
  source: DataSource;
  approved: DictionaryVersion | null;
  draft?: DictionaryVersion | null;
  schema_drift?: SchemaDriftItem[];
}

export interface DataGrant {
  user_id: string;
  grant: DataGrantLevel;
  granted_by: string;
  created_at: string | null;
}
