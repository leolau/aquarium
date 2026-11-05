import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { SoftwareUpgradeView } from "@/components/settings/SoftwareUpgradeView";
import { getT } from "@/i18n/server";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { SoftwareUpgradeStatus } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Settings → Software upgrade: the installed release, newer releases to pick
 * from, the upgrade job's progress and the history. The owner upgrades and
 * rolls back; admins see it read-only; members and viewers are sent to
 * "not available" (and the BFF and Python API refuse them too).
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
  initial = { ...initial, can_upgrade: principal.role === "owner" };
  return (
    <MobileShell title={(await getT("upgrade"))("title")}>
      <SoftwareUpgradeView initial={initial} />
    </MobileShell>
  );
}
