/**
 * C2 read check for the front door: is `<slug>` a local app this principal
 * may open in this mode?
 *
 * The registry list comes from `/api/tools?mode=` with the visitor's own
 * token, so the Python side has already applied `scope_filter`; the
 * `canReadTool` re-check mirrors `hermes_cli/access.py::can_read` so a
 * backend that ever returns more rows still cannot widen access. Every app
 * request goes through forward_auth, so the per-person list is cached for a
 * few seconds.
 */
import "server-only";

import { HermesApiError, type HermesApiClient } from "@/lib/api/client";
import type { AppMode } from "@/lib/apps/paths";
import type { Principal, Tool } from "@/types";

export type AppAccess =
  | { status: "ok"; tool: Tool }
  | { status: "not_found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 256;
const cache = new Map<string, { expires: number; tools: Tool[] }>();

export function clearAppAccessCache(): void {
  cache.clear();
}

/** Mirror of `hermes_cli/access.py::can_read` (no grants on registry rows). */
export function canReadTool(principal: Principal, visibility: string): boolean {
  if (principal.is_owner) return true;
  return visibility === "shared" || visibility === `private:${principal.user_id}`;
}

async function scopedTools(
  client: HermesApiClient,
  principal: Principal,
  mode: AppMode,
  now: number,
): Promise<Tool[] | AppAccess> {
  const key = `${principal.user_id}\u0000${mode}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.tools;
  try {
    const res = await client.tools(mode);
    if (!res.configured) return { status: "unavailable" };
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { expires: now + CACHE_TTL_MS, tools: res.tools });
    return res.tools;
  } catch (err) {
    if (err instanceof HermesApiError && (err.status === 401 || err.status === 403)) {
      return { status: "unauthenticated" };
    }
    return { status: "unavailable" };
  }
}

export async function resolveAppAccess(
  client: HermesApiClient,
  principal: Principal,
  slug: string,
  mode: AppMode,
  now: number = Date.now(),
): Promise<AppAccess> {
  const tools = await scopedTools(client, principal, mode, now);
  if (!Array.isArray(tools)) return tools;
  const tool = tools.find((t) => t.name === slug && t.mode === mode);
  if (!tool || tool.hosting !== "local" || !canReadTool(principal, tool.visibility)) {
    return { status: "not_found" };
  }
  if (mode === "prod" && !tool.enabled) return { status: "not_found" };
  return { status: "ok", tool };
}
