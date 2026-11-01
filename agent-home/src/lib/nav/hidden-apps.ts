/**
 * Server half of per-role menu visibility: the caller's effective hidden app
 * ids, read from the Python API (`GET /api/agent-home/nav`) and cached briefly.
 *
 * The effective list depends only on the role (the owner sees everything), so
 * the cache key is the role — never a token. A save calls `revalidateTag` with
 * `NAV_CACHE_TAG` and `clearLocalNavCache()`. Failures show everything: the
 * menu list is navigation, not a data permission (Python scopes the data).
 */
import "server-only";

import { unstable_cache } from "next/cache";

import { HermesApiClient } from "@/lib/api/client";
import { sanitizeHidden, seesEverything } from "@/lib/nav/menu-access";
import type { Principal } from "@/types";

export const NAV_CACHE_TAG = "agent-home-nav";
const CACHE_SECONDS = 60;

async function fetchHidden(hermesToken: string): Promise<string[]> {
  const body = await new HermesApiClient({ hermesToken }).agentHomeNav();
  return sanitizeHidden(Array.isArray(body.hidden) ? body.hidden : []);
}

function cachedHidden(role: string, hermesToken: string): Promise<string[]> {
  return unstable_cache(() => fetchHidden(hermesToken), ["agent-home-nav-hidden", role], {
    revalidate: CACHE_SECONDS,
    tags: [NAV_CACHE_TAG],
  })();
}

/**
 * Process-local fallback for contexts without Next's data cache (middleware).
 * Kept on `globalThis` so the middleware bundle and the route handlers that
 * clear it share one map inside the same server process.
 */
const LOCAL_KEY = Symbol.for("agent-home.nav.hidden");
type LocalCache = Map<string, { at: number; hidden: string[] }>;

function localCache(): LocalCache {
  const g = globalThis as unknown as Record<symbol, LocalCache | undefined>;
  return (g[LOCAL_KEY] ??= new Map());
}

export function clearLocalNavCache(): void {
  localCache().clear();
}

async function locallyCachedHidden(role: string, hermesToken: string): Promise<string[]> {
  const cache = localCache();
  const hit = cache.get(role);
  if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.hidden;
  const hidden = await fetchHidden(hermesToken);
  cache.set(role, { at: Date.now(), hidden });
  return hidden;
}

type Caller = { role: Principal["role"]; is_owner?: boolean };

/** The caller's hidden app ids; `[]` for the owner, a signed-out caller, or on error. */
export async function getHiddenApps(
  principal: Caller,
  hermesToken: string | undefined,
): Promise<string[]> {
  if (seesEverything(principal) || !hermesToken) return [];
  try {
    return await cachedHidden(principal.role, hermesToken);
  } catch {
    return [];
  }
}

/** `getHiddenApps` for middleware, where Next's data cache may be unavailable. */
export async function getHiddenAppsForMiddleware(
  principal: Caller,
  hermesToken: string | undefined,
): Promise<string[]> {
  if (seesEverything(principal) || !hermesToken) return [];
  try {
    return await locallyCachedHidden(principal.role, hermesToken);
  } catch {
    return [];
  }
}
