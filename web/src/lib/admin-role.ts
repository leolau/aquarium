import type { CommsPrincipal, CommsWhoamiResponse } from "@/lib/api";

/**
 * Whether the dashboard should show owner/admin-only controls.
 *
 * Mirrors the server check in hermes_cli/route_roles.py (owner or admin), fed
 * by the same principal the server resolves (`GET /api/comms/whoami`). This is
 * only about what the UI shows: the server's 403 stays the real guard.
 *
 * - "loading": whoami has not answered yet.
 * - "admin": owner/admin, a no-login operator, or no member datastore.
 * - "not-admin": a signed-in member or viewer.
 */
export type AdminRoleState = "loading" | "admin" | "not-admin";

export function canAdminister(
  principal: Pick<CommsPrincipal, "role" | "is_owner">,
): boolean {
  return (
    principal.is_owner ||
    principal.role === "owner" ||
    principal.role === "admin"
  );
}

export function adminStateFromWhoami(
  resp: CommsWhoamiResponse,
): AdminRoleState {
  if (!resp.configured || !resp.principal) return "admin";
  return canAdminister(resp.principal) ? "admin" : "not-admin";
}

/** whoami failed: 401/403 means the caller has no admin standing; anything
 * else (network, 5xx) keeps today's behaviour and lets the server decide. */
export function adminStateFromError(err: unknown): AdminRoleState {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const status = Number(/^(\d{3}):/.exec(msg)?.[1] ?? 0);
  return status === 401 || status === 403 ? "not-admin" : "admin";
}

/**
 * Pages whose main read or every action is owner/admin-only on the server
 * (dashboard routes with `dependencies=_ADMIN`, or the /api/pty terminal), so a
 * member would only see 403s there. Pages with member-readable data
 * (Models, MCP, Tools, Skills, Cron, Profiles, ...) stay visible and hide only
 * their admin buttons.
 */
export const ADMIN_ONLY_PAGES: ReadonlySet<string> = new Set([
  "/chat",
  "/files",
  "/logs",
  "/plugins",
  "/channels",
  "/telegram",
  "/webhooks",
  "/pairing",
  "/system",
  "/profiles/new",
  "/config",
  "/env",
]);

export function isAdminOnlyPage(path: string): boolean {
  return ADMIN_ONLY_PAGES.has(path.replace(/\/$/, "") || "/");
}

/** Hide admin-only nav entries only once we know the caller is not an admin,
 * so admins never see their sidebar flicker. */
export function visibleNavItems<T extends { path: string }>(
  items: readonly T[],
  state: AdminRoleState,
): T[] {
  if (state !== "not-admin") return [...items];
  return items.filter((item) => !isAdminOnlyPage(item.path));
}

/** Dashboard plugins with a backend API are served under /api/plugins/<name>,
 * which the server mounts owner/admin-only. */
export function visiblePluginManifests<T extends { has_api: boolean }>(
  manifests: readonly T[],
  state: AdminRoleState,
): T[] {
  if (state !== "not-admin") return [...manifests];
  return manifests.filter((m) => !m.has_api);
}
