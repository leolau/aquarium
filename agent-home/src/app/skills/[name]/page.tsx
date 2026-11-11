import { MobileShell } from "@/components/MobileShell";
import { SkillPage } from "@/components/skills/SkillPage";

import { apiClientForRequest } from "@/lib/auth/principal";
import { activeVersion, toVersionList } from "@/lib/skills/versions";

import { loadSkill } from "../load-skill";

export const dynamic = "force-dynamic";

/** One skill rendered as a document (`?profile=` picks whose copy). Needs the `view` Skills permission. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ profile?: string; tab?: string }>;
}) {
  const [{ name: raw }, { profile: requested, tab }] = await Promise.all([params, searchParams]);
  const { name, profile, content, skill, skills, details, permissions } = await loadSkill(raw, requested, true);
  // Version history is optional (older backends have none) and part of the Skills Lab.
  const client = await apiClientForRequest({ profile: profile === "default" ? undefined : profile });
  const versions = permissions.lab
    ? await client.skillVersions(name).then((d) => toVersionList(d, name), () => null)
    : null;
  const active = activeVersion(versions);
  return (
    <MobileShell
      title={name}
      subtitle={skill?.description || undefined}
      labels={{ [`/skills/${encodeURIComponent(name)}`]: name }}
      wide
    >
      <SkillPage
        key={`${profile}:${name}`}
        name={name}
        profile={profile}
        content={content}
        skill={skill}
        details={details}
        installed={skills.map((s) => s.name)}
        initialTab={tab}
        activeVersion={active ? { n: active.n, trial: Boolean(active.trial_of) } : null}
        permissions={permissions}
      />
    </MobileShell>
  );
}
