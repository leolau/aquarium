import { MobileShell } from "@/components/MobileShell";
import { SettingsView } from "@/components/settings/SettingsView";
import { InfoTip } from "@/components/ui/InfoTip";
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
  const t = await getT("settings");
  return (
    <MobileShell
      title={t("title")}
      subtitle={t("subtitle")}
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
      wide
    >
      <SettingsView
        canManageMembers={principal.is_owner || principal.role === "admin"}
        canManageTools={canManageTools(principal)}
      />
    </MobileShell>
  );
}
