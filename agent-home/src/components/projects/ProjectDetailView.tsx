"use client";

import { useCallback, useState, type ComponentType } from "react";

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { EditBriefSheet } from "@/components/projects/EditBriefSheet";
import { ProjectCategoryTag } from "@/components/projects/categories/ProjectCategoryTag";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";
import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import { ReadinessChecklist } from "@/components/projects/ReadinessChecklist";
import { JourneyBar } from "@/components/projects/dashboard/JourneyBar";
import { nextAction } from "@/components/projects/dashboard/nextAction";
import {
  extraFindings,
  isRunnable,
  readinessItems,
  type ReadinessItem,
} from "@/components/projects/readiness";
import { revealTarget } from "@/components/projects/revealTarget";
import {
  durationLabel,
  tokenCountLabel,
} from "@/components/projects/format";
import { SummariseSheet } from "@/components/projects/SummariseSheet";
import {
  CADENCE_GLYPH,
  CADENCE_LABEL,
  HEALTH_LABEL,
} from "@/components/projects/ProjectRow";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useRefresh } from "@/components/ui/useRefresh";
import { useProjectEvents } from "@/components/projects/useProjectEvents";
import { AskOrChangeBox } from "@/components/projects/ask/AskOrChangeBox";
import { ChangeRequestSheet } from "@/components/projects/changes/ChangeRequestSheet";
import { LiveStatusBar } from "@/components/projects/live/LiveStatusBar";
import { BoardTab } from "@/components/projects/tabs/BoardTab";
import { DashboardTab } from "@/components/projects/tabs/DashboardTab";
import { InputsTab } from "@/components/projects/tabs/InputsTab";
import { ScopeTab } from "@/components/projects/tabs/ScopeTab";
import { IterationsTab } from "@/components/projects/tabs/IterationsTab";
import { OutputsTab } from "@/components/projects/tabs/OutputsTab";
import { PlanTab } from "@/components/projects/tabs/PlanTab";
import { ProjectTabsNav } from "@/components/projects/tabs/ProjectTabsNav";
import { SettingsTab } from "@/components/projects/tabs/SettingsTab";
import {
  parseProjectTab,
  type ProjectTab,
  type ProjectTabProps,
} from "@/components/projects/tabs/types";
import type {
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectHealth,
  ProjectPlaybookResponse,
  ProjectUsage,
} from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

const HEALTH_TONE: Record<ProjectHealth, Tone> = {
  ok: "success",
  attention: "warning",
  stalled: "danger",
};

const TOOL_BTN =
  "rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50";

const TAB_COMPONENT: Record<ProjectTab, ComponentType<ProjectTabProps>> = {
  dashboard: DashboardTab,
  scope: ScopeTab,
  board: BoardTab,
  outputs: OutputsTab,
  iterations: IterationsTab,
  inputs: InputsTab,
  plan: PlanTab,
  settings: SettingsTab,
};

/**
 * `/projects/[slug]` — the one place (§13): a slim header, then a sticky
 * journey bar (the one next button) over the live status bar, an
 * ask-or-change box, then Dashboard + tabs. The Dashboard answers "what do I
 * do now"; everything else is one tab away (`?tab=`). Fan-out safe by construction — each separately-fetched resource
 * arrives as `| null` and its panel says "unavailable" instead of failing
 * the page (§16).
 */
export function ProjectDetailView({
  project,
  board,
  playbook,
  directives,
  doctor = null,
  callerUserId,
  isInstanceAdmin,
  initialTab,
}: {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  playbook: ProjectPlaybookResponse | null;
  directives: ProjectDirectivesResponse | null;
  /** Server-side findings the local checklist cannot see (§9.2). */
  doctor?: ProjectDoctorDetail | null;
  /** The signed-in principal's user id — the lifecycle gate (§13). */
  callerUserId: string;
  /** Box-wide owner/admin outranks the per-project matrix (§11). */
  isInstanceAdmin: boolean;
  /** From `?tab=`; anything unknown lands on the Dashboard. */
  initialTab?: string;
}) {
  const timeLabel = useTimeLabel();
  const { refresh, refreshing } = useRefresh();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { categories } = useProjectCategories();
  const [summariseOpen, setSummariseOpen] = useState(false);

  const callerRole =
    project.members.find((member) => member.user_id === callerUserId)?.role ??
    null;
  const canLead =
    isInstanceAdmin ||
    project.owner_user_id === callerUserId ||
    callerRole === "lead";
  const canAct = canLead || callerRole === "member";

  const readiness = readinessItems(project, playbook);
  const runnable = isRunnable(readiness);
  const findings = extraFindings(doctor, readiness);

  // §12 live updates: a run promoted in the background becomes visible
  // without a manual reload — the poller refreshes when the event head
  // moves (E3).
  useProjectEvents(project.slug);

  const blockedCount =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "blocked").length ?? 0;

  const [tab, setTab] = useState<ProjectTab>(() => parseProjectTab(initialTab));
  const selectTab = useCallback((next: ProjectTab) => {
    setTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "dashboard") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);
  // Open the tab that fixes a readiness gap, then scroll to and ring its field.
  const reveal = useCallback(
    (item: ReadinessItem) => {
      if (item.tab) selectTab(item.tab);
      if (item.target) revealTarget(item.target);
    },
    [selectTab],
  );
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState<string | undefined>(undefined);
  const openChange = (initialText?: string) => {
    setChangeText(initialText);
    setChangeOpen(true);
  };

  const triageCount =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "triage").length ?? 0;
  const tabBadges: Partial<Record<ProjectTab, number>> = {
    board: blockedCount + triageCount,
    scope: project.clarify?.open_count ?? 0,
  };
  const tabProps: ProjectTabProps = {
    project,
    board,
    playbook,
    directives,
    doctor,
    callerUserId,
    canLead,
    readiness,
    runnable,
    onNavigate: selectTab,
    onChangeRequest: openChange,
  };
  const ActiveTab = TAB_COMPONENT[tab];
  const action = nextAction(project, board, readiness, playbook, undefined, canLead);

  const meta = [
    project.status,
    CADENCE_LABEL[project.cadence],
    project.schedule ?? undefined,
    project.next_run_at != null
      ? `next ${timeLabel(project.next_run_at, "day")}`
      : undefined,
    project.autonomy,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div data-component="ProjectDetailView" className="flex flex-col gap-4">
      <BusyRegion
        busy={refreshing}
        label={refreshing ? "Talking to the agent…" : undefined}
      >
        <div className="flex flex-col gap-4">
          {/* ── Header ─────────────────────────────────────────────── */}
          <header
            id="project-header"
            data-component="ProjectHeader"
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="text-lg leading-none text-[var(--color-muted)]"
              >
                {CADENCE_GLYPH[project.cadence]}
              </span>
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
                {project.name}
              </h1>
              <Pill tone={HEALTH_TONE[project.health]}>
                {HEALTH_LABEL[project.health]}
              </Pill>
              <ProjectLifecycleMenu
                project={project}
                callerUserId={callerUserId}
                isInstanceAdmin={isInstanceAdmin}
              />
            </div>
            <div className="mt-1 flex">
              <ProjectCategoryTag
                categories={categories}
                categoryId={project.category_id}
              />
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">{meta}</p>

            {project.archived ? (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                This project is archived — restore it (⋯) to run it again.
              </p>
            ) : null}
          </header>
        </div>
      </BusyRegion>

      {/* ── Journey bar: sticky, right under the title, above every tab ── */}
      <div data-component="ProjectStickyBars" className="sticky top-0 z-30 -mx-1 bg-[var(--color-bg)] px-1 pb-1 pt-1">
        <JourneyBar
          project={project}
          action={action}
          readiness={readiness}
          canLead={canLead}
          canAct={canAct}
          onNavigate={selectTab}
          onReveal={reveal}
          onChangeRequest={openChange}
        />
      </div>

      {/* ── Tools, About, readiness: below the journey bar ─────────── */}
      {!project.archived || project.goal || project.usage || project.summary ? (
        <section
          data-component="ProjectDetails"
          aria-label="Project details"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 [&>*:first-child]:mt-0"
        >
          {!project.archived ? (
            <div
              data-component="ProjectToolbar"
              role="toolbar"
              aria-label="Project tools"
              className="mt-2 flex flex-wrap gap-1.5"
            >
              <button type="button" onClick={() => setAddOpen(true)} className={TOOL_BTN}>
                Add
              </button>
              {canLead ? (
                <button type="button" onClick={() => setEditOpen(true)} className={TOOL_BTN}>
                  Edit
                </button>
              ) : null}
              <button type="button" onClick={() => setSummariseOpen(true)} className={TOOL_BTN}>
                {project.summary ? "Update summary" : "Summarise"}
              </button>
            </div>
          ) : null}

          {project.goal || project.usage || project.summary ? (
            <details data-component="ProjectAbout" className="group mt-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted)]">
                About
              </summary>
              {project.goal ? (
                <p className="mt-1 text-sm text-[var(--color-muted)]">{project.goal}</p>
              ) : null}
              {project.usage ? <ProjectUsageLine usage={project.usage} /> : null}
              {project.summary ? (
                <div
                  data-component="ProjectSummary"
                  className="mt-2 rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                >
                  <p className="italic">{project.summary}</p>
                  {project.summary_at != null ? (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Summarised {timeLabel(project.summary_at, "ago")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </details>
          ) : null}

          {!project.archived && !runnable ? (
            <details data-component="ProjectReadinessDetails" className="mt-2">
              <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted)]">
                Before it can run · {readiness.filter((item) => item.ok).length} of {readiness.length} ready
              </summary>
              <ReadinessChecklist items={readiness} findings={findings} onItem={reveal} />
            </details>
          ) : null}
        </section>
      ) : null}

      <LiveStatusBar project={project} board={board} runnable={runnable} ownsNextStep={false} />


      {!project.archived ? (
        <AskOrChangeBox project={project} onChangeRequest={openChange} />
      ) : null}

      <ProjectTabsNav active={tab} onSelect={selectTab} badges={tabBadges} />

      <div
        data-component="ProjectTabPanel"
        role="tabpanel"
        data-active-tab={tab}
      >
        <ActiveTab {...tabProps} />
      </div>

      {addOpen ? (
        <AddToProjectSheet
          onClose={() => {
            setAddOpen(false);
            refresh();
          }}
          fixedSlug={project.slug}
          fixedName={project.name}
        />
      ) : null}

      {summariseOpen ? (
        <SummariseSheet
          slug={project.slug}
          initial={project.summary ?? ""}
          onClose={() => {
            setSummariseOpen(false);
            refresh();
          }}
        />
      ) : null}

      {changeOpen ? (
        <ChangeRequestSheet
          project={project}
          playbook={playbook}
          directives={directives}
          initialText={changeText}
          onClose={() => {
            setChangeOpen(false);
            refresh();
          }}
        />
      ) : null}

      {editOpen ? (
        <EditBriefSheet
          project={project}
          onClose={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * "Used so far: 1h 37m over 2 runs · 1.45M tokens" — the project's basic
 * cost at a glance. Tokens are what the model read and wrote; prompt text
 * re-read from the provider's cache is billed far cheaper, so it is shown
 * apart instead of inflating the total.
 */
export function ProjectUsageLine({ usage }: { usage: ProjectUsage }) {
  const runs = `${usage.runs} run${usage.runs === 1 ? "" : "s"}`;
  const tokens = usage.tokens;
  return (
    <p
      data-component="ProjectUsage"
      className="mt-1 text-xs text-[var(--color-muted)]"
    >
      <span className="font-medium text-[var(--color-fg)]">Used so far:</span>{" "}
      {usage.runs === 0
        ? "no runs yet"
        : `${durationLabel(usage.run_seconds)} over ${runs}`}
      {" · "}
      {tokens == null ? (
        "tokens not recorded"
      ) : (
        <span
          title={`${tokens.input_tokens.toLocaleString()} read, ${tokens.output_tokens.toLocaleString()} written, ${tokens.cache_read_tokens.toLocaleString()} re-read from cache, in ${tokens.calls.toLocaleString()} model calls`}
        >
          {tokenCountLabel(tokens.total)} tokens
          {tokens.total > 0
            ? ` (${tokenCountLabel(tokens.input_tokens)} read, ${tokenCountLabel(tokens.output_tokens)} written)`
            : ""}
          {tokens.cache_read_tokens > 0
            ? ` + ${tokenCountLabel(tokens.cache_read_tokens)} re-read from cache`
            : ""}
        </span>
      )}
    </p>
  );
}
