import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { InfoTip } from "@/components/ui/InfoTip";
import { SoftwareUpgradeView } from "@/components/settings/SoftwareUpgradeView";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister, canUpgradeSoftware } from "@/lib/auth/roles";
import type { SoftwareUpgradeStatus } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Software upgrade: the installed release, newer releases to pick
 * from, the upgrade job's progress and the history. The owner and admins
 * upgrade and roll back (each re-entering their own password); members and
 * viewers are sent to "not available" (and the BFF and Python API refuse them too).
 */
export default async function Page() {
  const principal = await requirePrincipal();
  if (!canAdminister(principal)) redirect("/not-available");
  let initial: SoftwareUpgradeStatus;
  try {
    initial = await (await apiClientForRequest()).softwareUpgrade();
  } catch (err) {
    initial = { available: false, error: err instanceof Error ? err.message : "" };
  }
  initial = { ...initial, can_upgrade: canUpgradeSoftware(principal) };
  const t = await getT("settings");
  return (
    <MobileShell
      title={(await getT("upgrade"))("title")}
      subtitle={t("entry.upgrade.hint")}
      info={<InfoTip label={t("upgrade.infoLabel")}>{t("upgrade.info")}</InfoTip>}
    >
      <SoftwareUpgradeView initial={initial} />
    </MobileShell>
  );
}
