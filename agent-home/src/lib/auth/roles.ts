/**
 * Role checks shared by pages, BFF routes, and client components. Roles are
 * fixed (owner > admin > member > viewer); see `hermes_cli/access.py`.
 */
import type { Principal } from "@/types";

/** Shown when a member/viewer tries to change Tools & Integrations. */
export const TOOLS_MANAGE_DENIED =
  "Only the owner or an admin can change tools and integrations.";

/**
 * Tool and MCP settings apply to everyone in the profile, so only the owner
 * and admins may change them; members and viewers can only look.
 */
export function canManageTools(
  principal: Pick<Principal, "role" | "is_owner">,
): boolean {
  return (
    principal.is_owner ||
    principal.role === "owner" ||
    principal.role === "admin"
  );
}
