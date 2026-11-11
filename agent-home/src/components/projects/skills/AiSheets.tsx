"use client";

import { Sheet } from "@/components/ui/Sheet";
import { skillsListHref } from "@/components/skills/skill-links";
import { useT } from "@/i18n";

import { improveHref, type ProjectSkill } from "./model";
import { projectSkillButtonClass } from "./ProjectSkillRow";

/**
 * Placeholders for the AI sheets. B3 replaces `ImproveSkillSheet` and B4
 * `CreateSkillSheet` with the real flows; keep these props.
 */
export interface ImproveSkillSheetProps {
  slug: string;
  skill: ProjectSkill;
  onClose: () => void;
}

export interface CreateSkillSheetProps {
  slug: string;
  /** The project's host profile (where the draft is created). */
  profile: string;
  candidateId?: string;
  onClose: () => void;
}

export function ImproveSkillSheet({ slug, skill, onClose }: ImproveSkillSheetProps) {
  const t = useT("projects");
  return (
    <Sheet title={t("skillsTab.placeholder.improveTitle", { name: skill.name })} onClose={onClose} component="ImproveSkillSheet">
      <p className="text-sm text-[var(--color-muted)]">{t("skillsTab.placeholder.improveBody")}</p>
      <a
        href={improveHref(skill.name, skill.profile, slug)}
        className={`${projectSkillButtonClass} mt-4 w-full border-[var(--color-accent)] text-[var(--color-accent)]`}
      >
        {t("skillsTab.placeholder.openLab")}
      </a>
    </Sheet>
  );
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
