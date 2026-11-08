import { MobileShell } from "@/components/MobileShell";
import { SkillEditor } from "@/components/skills/SkillEditor";
import { getT } from "@/i18n/server";

import { loadSkill } from "../../load-skill";

export const dynamic = "force-dynamic";

/** Edit one skill's SKILL.md (`?view=plain` opens the plain-text view). Owner/admin only. */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ profile?: string; view?: string }>;
}) {
  const [{ name: raw }, { profile: requested, view }] = await Promise.all([params, searchParams]);
  const { name, profile, content, skill, skills } = await loadSkill(raw, requested, false);
  const t = await getT("system");
  return (
    <MobileShell
      title={t("pages.skillEdit.title", { name })}
      labels={{ [`/skills/${encodeURIComponent(name)}`]: name }}
      wide
    >
      <SkillEditor
        key={`${profile}:${name}`}
        name={name}
        profile={profile}
        content={content}
        skill={skill}
        installed={skills.map((s) => s.name)}
        categories={Array.from(new Set(skills.map((s) => s.category).filter(Boolean)))}
        initialView={view === "plain" ? "plain" : "structured"}
      />
    </MobileShell>
  );
}
