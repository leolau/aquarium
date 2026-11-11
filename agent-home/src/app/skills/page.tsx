import { redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { SkillsView } from "@/components/skills/SkillsView";
import { getT } from "@/i18n/server";
import { toProfileInfo } from "@/lib/api/profile-info";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { getSkillPermissionsOrNone } from "@/lib/skills/permissions-server";
import type { SkillInfo } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Skills — what each agent knows. Follows Settings → Skills permissions:
 * `view` opens this page, `manage` adds the edit controls and the hub, `lab`
 * the usage signals (the BFF routes and Python re-check each). `?profile=` picks whose skills are
 * shown; `?view=hub` opens the Skills hub.
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

  const [list, skillList] = await Promise.allSettled([
    (await apiClientForRequest()).profileInfos(),
    (await apiClientForRequest({ profile: requested?.trim() || undefined })).skillList(),
  ]);
  const profiles = list.status === "fulfilled" ? (list.value.profiles ?? []).map(toProfileInfo) : [];
  const fallback = profiles.find((p) => p.is_default)?.name ?? "default";
  const profile = profiles.some((p) => p.name === requested) ? requested! : fallback;
  const skills: SkillInfo[] = skillList.status === "fulfilled" ? skillList.value : [];
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
        initialSkills={skills}
        initialView={view === "hub" && permissions.manage ? "hub" : "installed"}
        permissions={permissions}
        error={error}
      />
    </MobileShell>
  );
}
