import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { SkillEditor } from "@/components/skills/SkillEditor";
import { getT } from "@/i18n/server";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest } from "@/lib/auth/principal";

import { loadSkill } from "../../load-skill";

export const dynamic = "force-dynamic";

/**
 * Edit one skill's SKILL.md (`?view=plain` opens the plain-text view). With
 * `?draft=<version id>` it edits that draft version and saves a new draft
 * instead of the live skill. Needs the `manage` Skills permission.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ profile?: string; view?: string; draft?: string }>;
}) {
  const [{ name: raw }, { profile: requested, view, draft: draftId }] = await Promise.all([params, searchParams]);
  const { name, profile, content, skill, skills } = await loadSkill(raw, requested, false, "manage");
  let draft: { id: string; n: number; content: string } | null = null;
  if (draftId) {
    const client = await apiClientForRequest({ profile: profile === "default" ? undefined : profile });
    try {
      const d = await client.skillVersionDetail(name, draftId);
      draft = { id: d.meta?.id || draftId, n: d.meta?.n ?? 0, content: d.content ?? "" };
    } catch (err) {
      if (err instanceof HermesApiError && (err.status === 404 || err.status === 400)) notFound();
      throw err;
    }
  }
  const t = await getT("system");
  return (
    <MobileShell
      title={t("pages.skillEdit.title", { name })}
      labels={{ [`/skills/${encodeURIComponent(name)}`]: name }}
      wide
    >
      <SkillEditor
        key={`${profile}:${name}:${draft?.id ?? ""}`}
        name={name}
        profile={profile}
        content={draft ? draft.content : content}
        skill={skill}
        installed={skills.map((s) => s.name)}
        categories={Array.from(new Set(skills.map((s) => s.category).filter(Boolean)))}
        initialView={view === "plain" ? "plain" : "structured"}
        draft={draft ? { id: draft.id, n: draft.n } : undefined}
      />
    </MobileShell>
  );
}
