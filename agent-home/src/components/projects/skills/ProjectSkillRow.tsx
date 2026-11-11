"use client";

import { chipClass, accentChipClass } from "@/components/skills/SkillPage";
import { relativeTime } from "@/components/landing/chats/model";
import { useT } from "@/i18n";

import type { ProjectSkill } from "./model";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-xs hover:border-[var(--color-accent)] md:min-h-9";

function OutcomeBar({ skill }: { skill: ProjectSkill }) {
  const t = useT("projects");
  const total = skill.success + skill.partial + skill.failed;
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  return (
    <div
      role="img"
      aria-label={t("skillsTab.outcomeAria", {
        success: skill.success,
        partial: skill.partial,
        failed: skill.failed,
      })}
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
    >
      <span className="bg-[var(--color-success)]" style={{ width: pct(skill.success) }} />
      <span className="bg-[var(--color-warn)]" style={{ width: pct(skill.partial) }} />
      <span className="bg-[var(--color-danger)]" style={{ width: pct(skill.failed) }} />
    </div>
  );
}

function Trend({ trend }: { trend: ProjectSkill["trend"] }) {
  const t = useT("projects");
  if (trend.length === 0) return null;
  const max = Math.max(1, ...trend.map((d) => d.uses));
  return (
    <div
      data-testid="skill-trend"
      role="img"
      aria-label={t("skillsTab.trendAria")}
      className="hidden h-6 w-24 shrink-0 items-end gap-px sm:flex"
    >
      {trend.slice(-30).map((d) => (
        <span
          key={d.day}
          className="flex-1 rounded-sm bg-[var(--color-accent)] opacity-70"
          style={{ height: `${Math.max(8, (d.uses / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function ProjectSkillRow({
  skill,
  showProfile,
  canLab,
  onUses,
  onImprove,
}: {
  skill: ProjectSkill;
  /** Several profiles in this project: tell rows apart with a chip. */
  showProfile: boolean;
  /** Skills `lab` in this row's profile: run-level evidence and Improve. */
  canLab: boolean;
  onUses: (skill: ProjectSkill) => void;
  onImprove: (skill: ProjectSkill) => void;
}) {
  const t = useT("projects");
  const uses = skill.uses === 1 ? t("skillsTab.useOne") : t("skillsTab.uses", { count: skill.uses });
  const lastUsed = skill.lastUsedAt
    ? t("skillsTab.lastUsed", { when: relativeTime(skill.lastUsedAt) })
    : t("skillsTab.neverUsed");
  return (
    <li
      data-component="ProjectSkillRow"
      data-skill={`${skill.profile}/${skill.name}`}
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:flex-row md:items-center"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          {showProfile ? (
            <span className={chipClass} aria-label={t("skillsTab.profileChip", { profile: skill.profile })}>
              {skill.profile}
            </span>
          ) : null}
          {skill.category ? <span className={chipClass}>{skill.category}</span> : null}
          {skill.version ? <span className={chipClass}>{skill.version}</span> : null}
          {skill.preloaded ? <span className={chipClass}>{t("skillsTab.preloaded")}</span> : null}
          {skill.createdHere ? <span className={accentChipClass}>{t("skillsTab.createdHere")}</span> : null}
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          {uses} · {lastUsed}
        </p>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <OutcomeBar skill={skill} />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              {t("skillsTab.worked")} {skill.success} · {t("skillsTab.partly")} {skill.partial} ·{" "}
              {t("skillsTab.failed")} {skill.failed}
            </p>
          </div>
          <Trend trend={skill.trend} />
        </div>
      </div>
      {canLab ? (
        <div className="flex gap-2 md:shrink-0">
          <button type="button" className={`${buttonClass} flex-1 md:flex-none`} onClick={() => onUses(skill)}>
            {t("skillsTab.usesButton")}
          </button>
          <button
            type="button"
            className={`${buttonClass} flex-1 border-[var(--color-accent)] text-[var(--color-accent)] md:flex-none`}
            onClick={() => onImprove(skill)}
          >
            {t("skillsTab.improve")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

export { buttonClass as projectSkillButtonClass };
