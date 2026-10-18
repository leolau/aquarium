import { MobileShell } from "@/components/MobileShell";
import { SettingsView } from "@/components/settings/SettingsView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canManageTools } from "@/lib/auth/roles";
import type { EntityGoal } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings page. Client preferences (UI theme, tags) plus the entity goal.
 *
 * The entity goal is loaded here rather than in the client component: it is the
 * one piece of server state on this page, the principal is already resolved per
 * request, and a registry that is not configured should render as a sentence
 * rather than as a spinner that never resolves.
 */
export default async function Page() {
  const principal = await requirePrincipal();
  let entityGoal: EntityGoal | null = null;
  try {
    const client = await apiClientForRequest();
    entityGoal = (await client.entityGoal()).goal;
  } catch {
    // No registry (or it is unreachable): the section says so.
  }
  return (
    <MobileShell title="Settings">
      <SettingsView
        entityGoal={entityGoal}
        entityGoalReadOnly={!principal.is_owner}
        canManageMembers={
          principal.is_owner || principal.role === "admin"
        }
        canManageTools={canManageTools(principal)}
      />
    </MobileShell>
  );
}
