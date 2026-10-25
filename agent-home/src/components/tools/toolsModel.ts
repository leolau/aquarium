/**
 * Pure helpers behind the Tools page (FG-33 §7): which section a registry
 * row belongs to, its health dot, where its tile opens, and who may act.
 */
import { canAdminister } from "@/lib/auth/roles";
import type { Principal, Tool } from "@/types";

import type { AppQuotaSummary } from "./QuotaStrip";

/** Tile shape: local = solid squircle, external = outlined circle. */
export type AppKind = "local" | "external";
export type ToolSection = AppKind | "helper";
export type HealthState = "running" | "building" | "down" | "off" | "dev" | "unknown";

/** One entry of `GET /api/tools?include=health` (fields are all optional). */
export interface AppHealth {
  health?: string | null;
  /** The Python API's name for `health` (ok, degraded, down, building, off, unknown). */
  state?: string | null;
  runtime_state?: string | null;
  lifecycle_state?: string | null;
  provider?: string | null;
  checked_at?: string | null;
}

export interface ToolsHealthResponse {
  tools?: Array<Tool & { health?: AppHealth | string | null }>;
  health?: Record<string, AppHealth | string | null>;
}

export type Viewer = Pick<Principal, "user_id" | "role" | "is_owner">;

export const PROVIDERS = ["vercel", "railway", "aws_amplify", "alibaba_fc", "supabase"] as const;
export type ProviderId = (typeof PROVIDERS)[number] | "globe";

export function sectionOf(tool: Tool): ToolSection {
  if (tool.kind === "external" || tool.hosting === "external") return "external";
  if (tool.hosting === "local") return "local";
  // Unknown kinds and pre-FG-33 rows fall back to the text row.
  return "helper";
}

/** Health entries keyed by tool name, from either response shape. */
export function healthByName(data: ToolsHealthResponse | null | undefined): Map<string, AppHealth> {
  const out = new Map<string, AppHealth>();
  const norm = (h: AppHealth | string | null | undefined): AppHealth | null =>
    typeof h === "string" ? { health: h } : h ? { ...h, health: h.health ?? h.state ?? null } : null;
  for (const [name, h] of Object.entries(data?.health ?? {})) {
    const v = norm(h);
    if (v) out.set(name, v);
  }
  for (const tool of data?.tools ?? []) {
    const v = norm(tool.health);
    if (v && !out.has(tool.name)) out.set(tool.name, v);
  }
  return out;
}

export function deriveHealth(tool: Tool, h: AppHealth | null | undefined): HealthState {
  if (!tool.enabled || h?.lifecycle_state === "archived") return "off";
  const runtime = h?.runtime_state ?? null;
  const health = h?.health ?? h?.state ?? null;
  if (tool.build_state === "building" || runtime === "building" || runtime === "starting") {
    return "building";
  }
  if (runtime === "failed" || runtime === "over_quota" || health === "down") return "down";
  if (tool.build_state === "failed") return "down";
  if (health === "degraded" || health === "building") return "building";
  if (runtime === "running" || health === "ok") return tool.mode === "dev" ? "dev" : "running";
  if (runtime === "stopped" || runtime === "idle_stopped" || health === "off") return "off";
  return "unknown";
}

/** Where the tile opens: the public URL, else the path-routed local app. */
export function openUrl(tool: Tool): string | null {
  if (tool.public_url) return tool.public_url;
  if (sectionOf(tool) !== "local") return null;
  const base = tool.mode === "dev" ? "/apps-dev" : "/apps";
  return `${base}/${encodeURIComponent(tool.name)}/`;
}

export function isReady(tool: Tool, health: HealthState): boolean {
  return openUrl(tool) !== null && (health === "running" || health === "dev");
}

export function providerOf(tool: Tool, h?: AppHealth | null): ProviderId {
  const raw =
    (tool as Tool & { provider?: unknown }).provider ??
    h?.provider ??
    (tool.config_json as { provider?: unknown } | undefined)?.provider;
  return (PROVIDERS as readonly unknown[]).includes(raw) ? (raw as ProviderId) : "globe";
}

/** The app's owner, an admin or the instance owner (decision 9: no C6 for members). */
export function canManageApp(viewer: Viewer | null | undefined, tool: Tool): boolean {
  if (!viewer) return false;
  return canAdminister(viewer) || tool.owner_user_id === viewer.user_id;
}

export function displayName(tool: Tool): string {
  return tool.display_name?.trim() || tool.name;
}

/** One or two letters for a generated icon with no emoji. */
export function monogram(tool: Tool): string {
  const words = displayName(tool).split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 1);
  return letters.toUpperCase();
}

/** The `/chat?draft=` deep link for "Ask the agent to change it". */
export function askAgentHref(tool: Tool, prompt: string): string {
  return `/chat?draft=${encodeURIComponent(prompt.replace("{name}", tool.name))}`;
}

export function appApiPath(tool: Tool, suffix = ""): string {
  return `/api/tools/apps/${encodeURIComponent(tool.name)}${suffix}`;
}

/** `GET /api/tools/quota` (the caller's limits and use) as the QuotaStrip's summary. */
export interface ToolQuotaResponse {
  configured?: boolean;
  limits?: { per_member?: Record<string, number | null> } | null;
  usage?: {
    registered?: string[] | number | null;
    running?: string[] | number | null;
    ram_mb?: number | null;
    disk_mb?: number | null;
  } | null;
}

export function quotaSummary(data: ToolQuotaResponse | null | undefined): AppQuotaSummary | null {
  if (!data?.configured || !data.usage) return null;
  const count = (v: string[] | number | null | undefined) =>
    Array.isArray(v) ? v.length : typeof v === "number" ? v : undefined;
  const usage: NonNullable<AppQuotaSummary["usage"]> = {};
  const values = {
    apps_registered: count(data.usage.registered),
    apps_running: count(data.usage.running),
    ram_mb: data.usage.ram_mb ?? undefined,
    disk_mb: data.usage.disk_mb ?? undefined,
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number") usage[key as keyof typeof values] = value;
  }
  return { usage, limits: { per_member: data.limits?.per_member ?? {} } };
}
