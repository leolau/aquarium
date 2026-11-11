/** Site-to-schema (plan 2026-11-10-001 §3.6): shapes Hermes returns for /api/sites/*. */

export type SiteAccess = "read" | "admin";
export type SiteStatus = "draft" | "studying" | "awaiting_approval" | "active" | "paused" | "error";
export type SiteRefreshMode = "incremental" | "full";

export interface SiteSource {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  login_url: string | null;
  login_saved: boolean;
  owner_user_id: string;
  profile: string;
  status: SiteStatus;
  schema_name: string;
  schedule_cron: string | null;
  default_refresh_mode: SiteRefreshMode;
  created_at: string | null;
  updated_at: string | null;
  access?: SiteAccess;
  design_version?: number | null;
}

export interface SiteInput {
  name?: string;
  base_url?: string;
  login_url?: string | null;
  username?: string;
  password?: string;
  schedule_cron?: string | null;
  default_refresh_mode?: SiteRefreshMode;
  status?: "active" | "paused";
}

export interface SiteSettings {
  create_roles: string[];
  can_create: boolean;
}

export interface SiteDesign {
  version: number;
  status: string;
  design: Record<string, unknown>;
  /** Only for site admins. */
  recipe?: Record<string, unknown> | null;
  proposed_by: string | null;
  proposed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export interface SiteGrant {
  user_id: string;
  grant: SiteAccess;
  granted_by: string;
  created_at: string | null;
}

export interface SiteRun {
  id: string;
  mode: SiteRefreshMode;
  trigger: string;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  pages: number;
  inserted: number;
  updated: number;
  removed: number;
  versions: number;
  error?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface SiteTable {
  name: string;
  kind: "fixed" | "variable";
  reason: string;
  key: string[];
  columns: Record<string, unknown>[];
  refresh: Record<string, unknown>;
  rows: number;
  removed: number;
  last_seen: string | null;
}

export interface SiteTableRows {
  entity: string;
  kind: "fixed" | "variable";
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  page_size: number;
}

export interface SiteHistory {
  entity: string;
  key: string;
  kind: "fixed" | "variable";
  changes: Record<string, unknown>[];
  versions: Record<string, unknown>[];
}

export interface SiteTableQuery {
  q?: string;
  page?: number;
  page_size?: number;
  include_removed?: boolean;
}
