"use client";

import { useState } from "react";

import { chipClass } from "@/components/skills/SkillPage";
import { SkillUsagePanel } from "@/components/skills/SkillUsagePanel";
import { skillHref, skillsListHref } from "@/components/skills/skill-links";
import { ActionButton } from "@/components/ui/ActionButton";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n";
import { errorText } from "@/lib/admin-fetch";

import {
  SKILL_WINDOWS,
  canLabIn,
  percentLabel,
  worthImproving,
  type ProjectSkill,
  type ProjectSkillsView,
  type SkillWindow,
} from "./model";
import { ProjectSkillRow, projectSkillButtonClass } from "./ProjectSkillRow";
import { dismissCandidate } from "./dismissCandidate";
import { useProjectSkills } from "./store";

type Filter = "all" | "worth" | "created";
const FILTERS: readonly Filter[] = ["all", "worth", "created"];

export interface ProjectSkillsPanelProps {
  slug: string;
  /** The project's host profile: new skills are drafted here. */
  hostProfile: string;
  archived?: boolean;
  /** Open Setup › Settings (the preloaded-skills editor). */
  onOpenSetup: () => void;
  /** "Improve with AI" on a row (B3 sheet). */
  onImprove: (skill: ProjectSkill) => void;
  /** "New skill with AI" / "Create with AI" (B4 sheet). */
  onCreate: (seed: { candidateId?: string }) => void;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
    </div>
  );
}

function sectionTitle(text: string) {
  return <h3 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{text}</h3>;
}

export function ProjectSkillsPanel({
  slug,
  hostProfile,
  archived = false,
  onOpenSetup,
  onImprove,
  onCreate,
}: ProjectSkillsPanelProps) {
  const t = useT("projects");
  const [days, setDays] = useState<SkillWindow>(90);
  const [filter, setFilter] = useState<Filter>("all");
  const [usesOf, setUsesOf] = useState<ProjectSkill | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const { state, reload } = useProjectSkills(slug, days);
  const view: ProjectSkillsView | null = state.status === "ready" ? state.view : null;
  const canCreate = view ? canLabIn(view, hostProfile) : false;

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="mr-auto text-sm font-semibold">{t("skillsTab.title")}</h2>
      <label className="sr-only" htmlFor={`skills-window-${slug}`}>
        {t("skillsTab.window")}
      </label>
      <select
        id={`skills-window-${slug}`}
        value={days}
        onChange={(e) => setDays(Number(e.target.value) as SkillWindow)}
        className="min-h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs md:min-h-9"
      >
        {SKILL_WINDOWS.map((d) => (
          <option key={d} value={d}>
            {t("skillsTab.days", { days: d })}
          </option>
        ))}
      </select>
      <a href={skillsListHref(hostProfile)} className={projectSkillButtonClass}>
        {t("skillsTab.allSkills")}
      </a>
      {canCreate ? (
        <button
          type="button"
          onClick={() => onCreate({})}
          className={`${projectSkillButtonClass} border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]`}
        >
          {t("skillsTab.newSkill")}
        </button>
      ) : null}
    </div>
  );

  if (state.status === "loading") {
    return (
      <div data-component="ProjectSkillsPanel" className="flex flex-col gap-4">
        {header}
        <p role="status" className="text-sm text-[var(--color-muted)]">
          {t("skillsTab.loading")}
        </p>
      </div>
    );
  }
  if (state.status === "error" || !view) {
    return (
      <div data-component="ProjectSkillsPanel" className="flex flex-col gap-4">
        {header}
        <div role="alert" className="flex flex-col items-start gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <p className="text-sm">{t("skillsTab.error")}</p>
          <button type="button" onClick={() => void reload()} className={projectSkillButtonClass}>
            {t("skillsTab.retry")}
          </button>
        </div>
      </div>
    );
  }

  const profiles = new Set(view.skills.map((s) => s.profile));
  const hidden = view.profiles.filter((p) => p.hidden).map((p) => p.profile);
  const shown = view.skills.filter((s) =>
    filter === "worth" ? worthImproving(s) : filter === "created" ? s.createdHere : true,
  );
  const canDismiss = !archived;

  return (
    <div data-component="ProjectSkillsPanel" className="flex flex-col gap-4">
      {header}

      {hidden.length > 0 ? (
        <p data-testid="skills-hidden-profiles" className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)]">
          {t("skillsTab.hiddenProfiles", { profiles: hidden.join(", ") })}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label={t("skillsTab.stats.skills")} value={String(view.totals.skills)} />
        <Stat label={t("skillsTab.stats.uses")} value={String(view.totals.uses)} />
        <Stat label={t("skillsTab.stats.firstTime")} value={percentLabel(view.totals.firstTimeRate)} />
        <Stat label={t("skillsTab.stats.worth")} value={String(view.totals.worthImproving)} />
      </div>

      {view.candidates.length > 0 ? (
        <section data-testid="skills-candidates" className="flex flex-col gap-2">
          {sectionTitle(t("skillsTab.candidatesTitle"))}
          {dismissError ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {dismissError}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {view.candidates.map((c) => (
              <li
                key={c.id}
                data-candidate={c.id}
                className="flex flex-col gap-3 rounded-2xl border border-dashed border-[var(--color-accent)] bg-[var(--color-surface)] p-4 md:flex-row md:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {c.name}
                    {c.runNo !== null ? (
                      <span className={`${chipClass} ml-2`}>{t("skillsTab.candidateRun", { run: c.runNo })}</span>
                    ) : null}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--color-muted)]">
                    {c.preview || t("skillsTab.candidateHint")}
                  </p>
                </div>
                <div className="flex gap-2 md:shrink-0">
                  {canCreate ? (
                    <button
                      type="button"
                      onClick={() => onCreate({ candidateId: c.id })}
                      className={`${projectSkillButtonClass} flex-1 border-[var(--color-accent)] text-[var(--color-accent)] md:flex-none`}
                    >
                      {t("skillsTab.createWithAi")}
                    </button>
                  ) : null}
                  {canDismiss ? (
                    <ActionButton
                      className={`${projectSkillButtonClass} flex-1 md:flex-none`}
                      busyLabel={t("skillsTab.dismissing")}
                      onAction={async () => {
                        setDismissError(null);
                        try {
                          await dismissCandidate(slug, c.id);
                        } catch (err) {
                          setDismissError(`${t("skillsTab.dismissFailed")} ${errorText(err)}`);
                        }
                      }}
                    >
                      {t("skillsTab.dismiss")}
                    </ActionButton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.skills.length === 0 ? (
        <div data-testid="skills-empty" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
          <p className="text-sm">{t("skillsTab.empty", { days: view.days })}</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t("skillsTab.emptyHint")}</p>
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <div role="group" aria-label={t("skillsTab.filters.aria")} className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`${projectSkillButtonClass} ${filter === f ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
              >
                {t(`skillsTab.filters.${f}`)}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{t("skillsTab.noMatches")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((s) => (
                <ProjectSkillRow
                  key={`${s.profile}/${s.name}`}
                  skill={s}
                  showProfile={profiles.size > 1}
                  canLab={canLabIn(view, s.profile)}
                  onUses={setUsesOf}
                  onImprove={onImprove}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {view.unusedPreloaded.length > 0 ? (
        <section data-testid="skills-unused" className="flex flex-col gap-2">
          {sectionTitle(t("skillsTab.unusedTitle", { days: view.days }))}
          <div className="flex flex-wrap gap-1.5">
            {view.unusedPreloaded.map((name) => (
              <span key={name} className={chipClass}>
                {name}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3 md:flex-row md:items-center">
        <p className="flex-1 text-xs text-[var(--color-muted)]">{t("skillsTab.footnote")}</p>
        <button type="button" onClick={onOpenSetup} className={projectSkillButtonClass}>
          {t("skillsTab.manageSetup")}
        </button>
      </div>

      {usesOf && canLabIn(view, usesOf.profile) ? (
        <Sheet
          title={t("skillsTab.usesTitle", { name: usesOf.name })}
          onClose={() => setUsesOf(null)}
          wide
          component="ProjectSkillUsesSheet"
        >
          <SkillUsagePanel
            name={usesOf.name}
            profile={usesOf.profile}
            project={slug}
            tabHref={(tab) => skillHref(usesOf.name, usesOf.profile, "", `tab=${tab}`)}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
