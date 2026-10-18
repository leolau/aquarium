/**
 * Role checks shared by pages, BFF routes, and client components. Roles are
 * fixed (owner > admin > member > viewer); see `hermes_cli/access.py`.
 */
import type { Principal } from "@/types";

/** Shown when a member/viewer tries to change Tools & Integrations. */
export const TOOLS_MANAGE_DENIED =
  "Only the owner or an admin can change tools and integrations.";

/** Shown when a member/viewer tries an owner/admin-only change. */
export const ADMIN_ONLY_DENIED =
  "Only the owner or an admin can change this setting.";

/**
 * Settings that apply to everyone in the profile (models, provider keys,
 * tools) or reach the host are owner/admin only; members and viewers can only
 * look. Mirrors `hermes_cli/route_roles.py` on the Python side.
 */
export function canAdminister(
  principal: Pick<Principal, "role" | "is_owner">,
): boolean {
  return (
    principal.is_owner ||
    principal.role === "owner" ||
    principal.role === "admin"
  );
}

/** Tool and MCP settings follow the same owner/admin rule. */
export const canManageTools = canAdminister;
