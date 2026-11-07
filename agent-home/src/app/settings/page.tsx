import { MobileShell } from "@/components/MobileShell";
import { SettingsView } from "@/components/settings/SettingsView";
import { getT } from "@/i18n/server";
import { requirePrincipal } from "@/lib/auth/principal";
import { canManageTools } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Settings index: one tile per section the caller may open. Each tile opens
 * that section's own page (`/settings/[section]`, or its existing route).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  return (
    <MobileShell title={(await getT("settings"))("title")}>
      <SettingsView
        canManageMembers={principal.is_owner || principal.role === "admin"}
        canManageTools={canManageTools(principal)}
      />
    </MobileShell>
  );
}
