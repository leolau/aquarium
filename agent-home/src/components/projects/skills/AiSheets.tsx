"use client";

import { Sheet } from "@/components/ui/Sheet";
import { skillsListHref } from "@/components/skills/skill-links";
import { useT } from "@/i18n";

import { projectSkillButtonClass } from "./ProjectSkillRow";

/** Placeholder for the AI create sheet; B4 replaces `CreateSkillSheet` (keep the props). */
export interface CreateSkillSheetProps {
  slug: string;
  /** The project's host profile (where the draft is created). */
  profile: string;
  candidateId?: string;
  onClose: () => void;
}

export function CreateSkillSheet({ profile, onClose }: CreateSkillSheetProps) {
  const t = useT("projects");
  return (
    <Sheet title={t("skillsTab.placeholder.createTitle")} onClose={onClose} component="CreateSkillSheet">
      <p className="text-sm text-[var(--color-muted)]">{t("skillsTab.placeholder.createBody")}</p>
      <a href={skillsListHref(profile)} className={`${projectSkillButtonClass} mt-4 w-full`}>
        {t("skillsTab.placeholder.openSkills")}
      </a>
    </Sheet>
  );
}
