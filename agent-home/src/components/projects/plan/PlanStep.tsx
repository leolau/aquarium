"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { planDiff } from "@/components/projects/changes/planDiff";
import { PlanDiffView } from "@/components/projects/changes/PlanDiffView";
import { useChangesHistory } from "@/components/projects/iterations/useChangesHistory";
import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import {
  VersionRail,
  type VersionRow,
} from "@/components/projects/steps/VersionRail";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { useT } from "@/i18n";
import type { Translator } from "@/i18n/translate";
import { Pill } from "@/components/ui/Pill";
import { useTimeLabel, type TimeLabelKind } from "@/components/projects/useTimeLabel";
import type { PlaybookRev, PlaybookStep } from "@/types";

/**
 * The Plan step (redesign, frame "Project detail — Plan step"): the active
 * plan version as numbered step rows — profile pill, "Why:" the planner's
 * assignee reason, "Needs approval" on checkpoints — with a Steps⇄Diff
 * toggle, an out-of-date banner when requirements moved on, and the shared
 * versions rail (USED BY groups runs by their pinned `playbook_rev`).
 *
 * Gaps vs the mockup (documented): steps don't record which inputs they
 * use so per-step source chips are skipped; "from Req v{N}" lineage isn't
 * stored so the banner compares change times to `activated_at`; Edit
 * reveals the existing `PlanPanel` rather than a bespoke editor.
 */
export function PlanStep({
  project,
  playbook,
  canLead,
  callerUserId,
  people,
  onNavigate,
  onDiscussInChat,
}: ProjectTabProps) {
  const t = useT("projects");
  const timeLabel = useTimeLabel();
  const [mode, setMode] = useState<"steps" | "diff">("steps");
  const [editOpen, setEditOpen] = useState(false);
  // The editor mounts below the steps list — on a plan with long step
  // bodies that is below the fold, so Edit must scroll it into view or it
  // looks like the click did nothing.
  const editorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (editOpen) {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [editOpen]);

  const active = playbook?.active ?? null;
  const steps = active?.steps ?? [];
  const previous = useMemo<PlaybookRev | null>(() => {
    if (!active) return null;
    const older = (playbook?.revisions ?? [])
      .filter((r) => r.rev < active.rev)
      .sort((a, b) => b.rev - a.rev);
    return older[0] ?? null;
  }, [playbook, active]);
  const diff = useMemo(
    () =>
      active && previous
        ? planDiff(previous.steps ?? [], active.steps ?? [])
        : null,
    [active, previous],
  );

  const history = useChangesHistory(project.slug, project);
  const staleSince = useMemo(() => {
    if (!active?.activated_at) return 0;
    return (history?.changes ?? []).filter(
      (c) => c.created_at > active.activated_at!,
    ).length;
  }, [history, active]);

  const usedByRuns = useMemo(() => {
    const byRev = new Map<number, number[]>();
    for (const r of history?.runs ?? []) {
      if (r.playbook_rev == null) continue;
      const list = byRev.get(r.playbook_rev) ?? [];
      list.push(r.run_no);
      byRev.set(r.playbook_rev, list);
    }
    return byRev;
  }, [history]);

  const versionRows = useMemo<VersionRow[]>(
    () =>
      [...(playbook?.revisions ?? [])]
        .sort((a, b) => b.rev - a.rev)
        .map((r) => ({
          rev: r.rev,
          current: r.rev === active?.rev,
          note:
            (r.requirement_rev
              ? `${t("planStep.fromReq", { rev: r.requirement_rev })} · `
              : "") +
            (r.note?.trim() ||
              `${(r.steps ?? []).length} ${t("planStep.stepsWord")}`),
          author: r.created_by === "agent" ? t("planStep.agent") : personName(r.created_by, people),
          at: r.activated_at ?? r.created_at,
        })),
    [playbook, active, t, people],
  );

  const role =
    project.members.find((m) => m.user_id === callerUserId)?.role ?? null;
  const canEdit = canLead && !project.archived;

  return (
    <div
      data-component="PlanStep"
      className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]"
    >
      <div className="flex min-w-0 flex-col gap-3">
        {staleSince > 0 ? (
          <div
            data-testid="plan-stale-banner"
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-2"
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-warn)] text-[10px] font-bold text-[var(--color-bg)]">
              !
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("planStep.staleTitle")}</p>
              <p className="text-xs text-[var(--color-muted)]">
                {t("planStep.staleBody", {
                  rev: active?.rev ?? 0,
                  count: staleSince,
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate("reqdoc")}
              data-appmcp-hint="See the requirements that changed"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
            >
              {t("planStep.seeChanges")}
            </button>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              disabled={!canEdit}
              data-appmcp-hint="Update the plan to match the new requirements"
              className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {t("planStep.updatePlan")}
            </button>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t("planStep.title")}</h2>
            {active ? <Pill tone="accent">v{active.rev}</Pill> : null}
            {active ? (
              <span className="text-xs text-[var(--color-muted)]">
                {provenance(active, timeLabel, t, people)}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-1.5">
              {previous && active ? (
                <span
                  role="tablist"
                  aria-label={t("planStep.viewToggle")}
                  className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] p-0.5"
                >
                  {(["steps", "diff"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={mode === m}
                      onClick={() => setMode(m)}
                      data-appmcp-hint={
                        m === "steps"
                          ? "Show the plan's steps"
                          : `Show the diff v${previous.rev} to v${active.rev}`
                      }
                      className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold ${
                        mode === m
                          ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                          : "text-[var(--color-muted)]"
                      }`}
                    >
                      {m === "steps"
                        ? t("planStep.steps")
                        : `${t("planStep.diff")} v${previous.rev} → v${active.rev}`}
                    </button>
                  ))}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setEditOpen((v) => !v)}
                disabled={!canEdit}
                data-appmcp-hint="Open the plan editor"
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                {t("planStep.edit")}
              </button>
              <button
                type="button"
                onClick={() => onNavigate("board")}
                data-appmcp-hint="Go to the cards this plan produces"
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold"
              >
                {t("planStep.makeCards")}
              </button>
            </span>
          </div>

          {/* Body */}
          {mode === "diff" && diff ? (
            <PlanDiffView diff={diff} />
          ) : steps.length ? (
            <ol className="flex flex-col gap-2" data-testid="plan-steps">
              {steps.map((s, i) => (
                <PlanStepRow key={s.key || i} step={s} n={i + 1} />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              {t("planStep.empty")}
            </p>
          )}
        </div>

        {editOpen ? (
          <div
            ref={editorRef}
            data-testid="plan-editor"
            className="scroll-mt-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <PlanPanel
              slug={project.slug}
              playbook={playbook}
              profiles={project.profiles.map((row) => row.profile)}
              hostProfile={project.host_profile}
              canActivate={canLead}
              canPropose={canLead || role === "member"}
              callerUserId={callerUserId}
              onAsk={onDiscussInChat}
              archived={project.archived}
              latestRunNo={
                project.runs.length > 0
                  ? Math.max(...project.runs.map((r) => r.run_no))
                  : null
              }
            />
          </div>
        ) : null}
      </div>

      <VersionRail
        rows={versionRows}
        usedBy={
          usedByRuns.size ? (
            <div className="flex flex-col gap-0.5">
              {[...usedByRuns.entries()]
                .sort((a, b) => b[0] - a[0])
                .slice(0, 3)
                .map(([rev, runs]) => (
                  <p key={rev}>
                    {t("planStep.usedByRuns", {
                      rev,
                      runs: runs.map((n) => `R${n}`).join(", "),
                    })}
                  </p>
                ))}
            </div>
          ) : null
        }
      />
    </div>
  );
}

function PlanStepRow({ step, n }: { step: PlaybookStep; n: number }) {
  const t = useT("projects");
  return (
    <li
      className="flex gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5"
      data-step-key={step.key}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-xs font-bold">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {step.title}
          {step.checkpoint ? (
            <Pill tone="warning">{t("planStep.needsApproval")}</Pill>
          ) : null}
        </p>
        {step.body ? (
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            {step.body}
          </p>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          {step.assignee ? <Pill tone="muted">{step.assignee}</Pill> : null}
          {step.assignee_reason ? <span>Why: {step.assignee_reason}</span> : null}
        </p>
      </div>
    </li>
  );
}

function provenance(
  rev: PlaybookRev,
  timeLabel: (ts: number, kind?: TimeLabelKind) => string,
  t: Translator,
  people?: Record<string, string>,
): string {
  const who =
    rev.created_by === "agent"
      ? t("planStep.generatedByAgent")
      : rev.created_by
        ? t("planStep.createdBy", { who: personName(rev.created_by, people) })
        : "";
  const when = rev.activated_at ? timeLabel(rev.activated_at, "ago") : null;
  return [who, when].filter(Boolean).join(" · ");
}

function personName<T extends string | null>(userId: T, people?: Record<string, string>): T | string {
  return userId ? (people?.[userId] ?? userId) : userId;
}
