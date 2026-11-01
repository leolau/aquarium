/**
 * Server half of per-role menu visibility: the caller's effective hidden app
 * ids, read from the Python API (`GET /api/agent-home/nav`) and cached briefly.
 *
 * The effective list depends only on the role (the owner sees everything), so
 * cache keys are the role, never a token. A save calls `revalidateTag` with
 * `NAV_CACHE_TAG` and `clearLocalNavCache()`; another server process still
 * serves its middleware copy for up to `NAV_CACHE_SECONDS`.
 *
 * Stale on error: when a lookup fails, the role's last fetched list is served
 * (so a Python hiccup does not unblock hidden URLs). Only a role that was
 * never fetched falls back to showing everything.
 */
import "server-only";

import { unstable_cache } from "next/cache";

import { HermesApiClient } from "@/lib/api/client";
import { sanitizeHidden, seesEverything } from "@/lib/nav/menu-access";
import type { Principal } from "@/types";

export const NAV_CACHE_TAG = "agent-home-nav";
/** Longest a saved change can take to reach the launcher or URL blocking. */
export const NAV_CACHE_SECONDS = 30;

/**
 * Per-role state shared by the page path and the middleware bundle (kept on
 * `globalThis` so both see one map inside a server process): `hidden` is the
 * last list fetched, `at` when; `fresh` is false once a save cleared it.
 */
const STATE_KEY = Symbol.for("agent-home.nav.hidden");
type RoleState = { at: number; hidden: string[]; fresh: boolean };
type State = Map<string, RoleState>;

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[STATE_KEY] ??= new Map());
}

/** Drop this process's middleware copies; the last-known lists stay for errors. */
export function clearLocalNavCache(): void {
  for (const entry of state().values()) entry.fresh = false;
}

async function fetchHidden(role: string, hermesToken: string): Promise<string[]> {
  const body = await new HermesApiClient({ hermesToken }).agentHomeNav();
  const hidden = sanitizeHidden(Array.isArray(body.hidden) ? body.hidden : []);
  state().set(role, { at: Date.now(), hidden, fresh: true });
  return hidden;
}

function lastKnown(role: string, err: unknown): string[] {
  const known = state().get(role);
  console.warn(
    `[agent-home nav] menu lookup for role "${role}" failed; ${
      known ? "serving the last known list" : "no list known yet, showing everything"
    }: ${err instanceof Error ? err.message : String(err)}`,
  );
  return known?.hidden ?? [];
}

type Caller = { role: Principal["role"]; is_owner?: boolean };

/** The caller's hidden app ids; `[]` for the owner or a signed-out caller. */
export async function getHiddenApps(
  principal: Caller,
  hermesToken: string | undefined,
): Promise<string[]> {
  if (seesEverything(principal) || !hermesToken) return [];
  const role = principal.role;
  try {
    return await unstable_cache(() => fetchHidden(role, hermesToken), ["agent-home-nav-hidden", role], {
      revalidate: NAV_CACHE_SECONDS,
      tags: [NAV_CACHE_TAG],
    })();
  } catch (err) {
    return lastKnown(role, err);
  }
}

/**
 * `getHiddenApps` for middleware, which has no Next data cache: a
 * process-local copy per role, refetched after `NAV_CACHE_SECONDS`.
 */
export async function getHiddenAppsForMiddleware(
  principal: Caller,
  hermesToken: string | undefined,
): Promise<string[]> {
  if (seesEverything(principal) || !hermesToken) return [];
  const role = principal.role;
  const hit = state().get(role);
  if (hit?.fresh && Date.now() - hit.at < NAV_CACHE_SECONDS * 1000) return hit.hidden;
  try {
    return await fetchHidden(role, hermesToken);
  } catch (err) {
    return lastKnown(role, err);
  }
}
