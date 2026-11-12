import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { canOpenSettingsSection, isDetailSection } from "@/components/settings/sections";
import { SettingsView } from "@/components/settings/SettingsView";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canManageTools } from "@/lib/auth/roles";
import type { EntityGoal } from "@/types";

export const dynamic = "force-dynamic";

/**
 * One Settings section on its own page. Unknown ids, and sections the caller
 * may not open, are a 404.
 *
 * The entity goal is loaded here rather than in the client component: the
 * principal is already resolved per request, and a registry that is not
 * configured should render as a sentence rather than a spinner.
 */
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const principal = await requirePrincipal();
  const access = {
    canManageMembers: principal.is_owner || principal.role === "admin",
    canManageTools: canManageTools(principal),
    isOwner: principal.is_owner,
  };
  if (!isDetailSection(section) || !canOpenSettingsSection(section, access)) notFound();

  let entityGoal: EntityGoal | null = null;
  if (section === "entity-goal") {
    try {
      const client = await apiClientForRequest();
      entityGoal = (await client.entityGoal()).goal;
    } catch {
      // No registry (or it is unreachable): the section says so.
    }
  }
  return (
    <MobileShell title={(await getT("settings"))(`section.${section}`)}>
      <SettingsView
        section={section}
        entityGoal={entityGoal}
        entityGoalReadOnly={!principal.is_owner}
        {...access}
        isOwner={principal.is_owner}
      />
    </MobileShell>
  );
}
