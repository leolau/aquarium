import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { SkillsView } from "@/components/skills/SkillsView";
import { getT } from "@/i18n/server";
import { toProfileInfo } from "@/lib/api/profile-info";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { getSkillPermissionsOrNone } from "@/lib/skills/permissions-server";
import type { SkillLibrary } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Skills — the box-wide skills library: built-in, hub, shared and each
 * profile's own skills, with which profiles use them (and the caller's
 * triage pipelines' skills under ◆ Triage). Follows Settings → Skills permissions:
 * `view` opens this page, `manage` adds the edit controls and the hub, `lab`
 * the usage signals (the BFF routes and Python re-check each). `?profile=` picks where new skills
 * and hub installs go; `?view=hub` opens the Skills hub.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string; view?: string }>;
}) {
  const principal = await requirePrincipal();
  const t = await getT("system");
  const { profile: requested, view } = await searchParams;
  const permissions = await getSkillPermissionsOrNone(principal, requested?.trim() || undefined);
  if (!permissions.view) redirect("/not-available?app=skills");

  const client = await apiClientForRequest();
  const [list, skillList, triage] = await Promise.allSettled([
    client.profileInfos(),
    client.skillLibrary(),
    client.triageStatus(),
  ]);
  const profiles = list.status === "fulfilled" ? (list.value.profiles ?? []).map(toProfileInfo) : [];
  const fallback = profiles.find((p) => p.is_default)?.name ?? "default";
  const profile = profiles.some((p) => p.name === requested) ? requested! : fallback;
  const library: SkillLibrary =
    skillList.status === "fulfilled" ? skillList.value : { profiles: profiles.map((p) => p.name), skills: [] };
  const error =
    skillList.status === "rejected"
      ? skillList.reason instanceof Error
        ? skillList.reason.message
        : "Failed to load skills"
      : null;

  return (
    <MobileShell title={t("cards.skills.name")} subtitle={t("pages.skills.subtitle")} wide>
      <SkillsView
        key={`${profile}:${view ?? ""}`}
        profiles={profiles.map((p) => p.name)}
        profile={profile}
        initialLibrary={library}
        triage={triage.status === "fulfilled" ? triage.value : null}
        canAdminister={canAdminister(principal)}
        initialView={view === "hub" && permissions.manage ? "hub" : "installed"}
        permissions={permissions}
        error={error}
      />
    </MobileShell>
  );
}
