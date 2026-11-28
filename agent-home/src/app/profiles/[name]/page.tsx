import { notFound, redirect } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ProfilePage } from "@/components/profiles/page/ProfilePage";
import { toProfileInfo } from "@/lib/api/profile-info";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { MembersResponse } from "@/types";
import type { NeedsYouResponse } from "@/types/landing";
import type { SkillUsageList } from "@/lib/skills/usage";

export const dynamic = "force-dynamic";

/**
 * Agent profile — the whole agent on one page: how it's doing, what it's
 * good at, how to reach it, what it's been doing, and the knobs that change
 * all of the above. Owner/admin only, like the profiles grid it opens from.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const principal = await requirePrincipal();
  if (!canAdminister(principal)) redirect("/not-available?app=profiles");
  const { name } = await params;
  const profileName = decodeURIComponent(name);

  const client = await apiClientForRequest();
  const bound = await apiClientForRequest({ profile: profileName });

  const [
    infos,
    statsRes,
    options,
    soul,
    library,
    sourcesRes,
    projectsRes,
    sessionsRes,
    cronRes,
    mcpRes,
    membersRes,
    needsRes,
    usageRes,
  ] = await Promise.allSettled([
    client.profileInfos(),
    client.profileStats(30),
    client.modelOptions(),
    client.profileSoul(profileName),
    client.skillLibrary(),
    client.sources(),
    client.projects({ limit: 100 }),
    bound.sessions({ limit: 20, excludeSources: "cron" }),
    bound.cronJobs(),
    bound.mcpServers(),
    bound.request<MembersResponse>("/api/comms/members?limit=100"),
    bound.request<NeedsYouResponse>("/api/needs-you"),
    bound.request<SkillUsageList>("/api/skills/usage?days=90"),
  ]);

  if (infos.status !== "fulfilled") {
    const message = infos.reason instanceof Error ? infos.reason.message : "Failed to load profiles";
    return (
      <MobileShell title="Agent profile" back={{ href: "/profiles", label: "Agent profiles" }} wide>
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-danger)]">
          {message}
        </div>
      </MobileShell>
    );
  }

  const profiles = (infos.value.profiles ?? []).map(toProfileInfo);
  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) notFound();

  const pick = <T,>(r: PromiseSettledResult<T>): T | null =>
    r.status === "fulfilled" ? r.value : null;

  const stats = pick(statsRes)?.profiles?.[profileName] ?? null;
  const providers = (pick(options)?.providers ?? []).filter((p) => p.models.length > 0);
  const projects = (pick(projectsRes)?.items ?? []).filter(
    (p) => p.host_profile === profileName,
  );
  const sources = pick(sourcesRes)?.sources ?? [];
  const sessions = pick(sessionsRes)?.sessions ?? [];
  const members = pick(membersRes)?.members ?? [];
  const needsYou = pick(needsRes)?.items ?? [];
  const skillUses = pick(usageRes)?.skills ?? [];

  return (
    <MobileShell
      title={profile.name}
      back={{ href: "/profiles", label: "Agent profiles" }}
      wide
    >
      <ProfilePage
        profile={profile}
        stats={stats}
        providers={providers}
        soul={pick(soul)?.content ?? ""}
        library={pick(library)}
        sources={sources}
        sessions={sessions}
        cronJobs={pick(cronRes) ?? []}
        mcpServers={pick(mcpRes)?.servers ?? []}
        members={members}
        needsYou={needsYou}
        skillUses={skillUses}
        projects={projects}
      />
    </MobileShell>
  );
}
