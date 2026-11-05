import { MobileShell } from "@/components/MobileShell";
import { SkillPage } from "@/components/skills/SkillPage";

import { loadSkill } from "../load-skill";

export const dynamic = "force-dynamic";

/** One skill rendered as a document (`?profile=` picks whose copy). Owner/admin only. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ profile?: string }>;
}) {
  const [{ name: raw }, { profile: requested }] = await Promise.all([params, searchParams]);
  const { name, profile, content, skill, skills, details } = await loadSkill(raw, requested, true);
  return (
    <MobileShell title="Skills" wide>
      <SkillPage
        key={`${profile}:${name}`}
        name={name}
        profile={profile}
        content={content}
        skill={skill}
        details={details}
        installed={skills.map((s) => s.name)}
      />
    </MobileShell>
  );
}
