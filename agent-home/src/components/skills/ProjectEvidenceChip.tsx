"use client";

import { accentChipClass } from "@/components/skills/SkillPage";
import type { EvidenceProject } from "@/components/skills/SkillImprovePanel";
import { useT } from "@/i18n/client";

/** "Evidence: project <name>" — the Skills Lab views are scoped to one project's runs. */
export function ProjectEvidenceChip({
  project,
  onClear,
  className = "",
}: {
  project: EvidenceProject;
  onClear?: () => void;
  className?: string;
}) {
  const t = useT("projects");
  return (
    <span data-component="ProjectEvidenceChip" className={`${accentChipClass} !inline-flex items-center gap-1 ${className}`}>
      {t("skillImprove.evidenceChip", { name: project.name || project.slug })}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("skillImprove.evidenceChipClear")}
          title={t("skillImprove.evidenceChipClear")}
          className="-my-2 -mr-1.5 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full sm:min-h-6 sm:min-w-6"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
    </span>
  );
}
