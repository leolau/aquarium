"use client";

import { useCallback, useState, type ComponentType } from "react";

import { ChevronDownIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";

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
import {
  GROUP_SECTIONS,
  groupOf,
  isProjectGroup,
  type ProjectGroup,
} from "@/components/projects/tabs/groups";
import { SettingsTab } from "@/components/projects/tabs/SettingsTab";
import {
  PROJECT_TAB_LABEL,
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

  const t = useT("projects");
  const [tab, setTab] = useState<ProjectTab>(() =>
    isProjectGroup(initialTab) ? GROUP_SECTIONS[initialTab][0] : parseProjectTab(initialTab),
  );
  const group = groupOf(tab);
  // `?tab=` names the tab (or, for a deep link, the section inside it).
  const writeTabParam = (value: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!value || value === "overview" || value === "dashboard") url.searchParams.delete("tab");
    else url.searchParams.set("tab", value);
    window.history.replaceState(window.history.state, "", url.toString());
  };
  const selectTab = useCallback((next: ProjectTab) => {
    setTab(next);
    writeTabParam(GROUP_SECTIONS[groupOf(next)][0] === next ? groupOf(next) : next);
    if (GROUP_SECTIONS[groupOf(next)][0] !== next && typeof window !== "undefined") {
      window.requestAnimationFrame(() =>
        document.getElementById(`project-section-${next}`)?.scrollIntoView({ block: "start" }),
      );
    }
  }, []);
  const selectGroup = (next: ProjectGroup) => {
    setTab(GROUP_SECTIONS[next][0]);
    writeTabParam(next);
  };
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
  const tabBadges: Partial<Record<ProjectGroup, number>> = {
    work: blockedCount + triageCount,
    setup: project.clarify?.open_count ?? 0,
  };
  const needsYou = blockedCount + triageCount;
  const liveRun = project.runs.find((run) => run.status === "running" || run.status === "waiting");
  // A saved open/closed choice (this browser) wins over the live-run default.
  const [savedStatus, saveStatus] = usePersistentState<StatusPref>(
    STATUS_OPEN_KEY,
    null,
    parseStatusPref,
    String,
  );
  const statusOpen = savedStatus ? savedStatus === "open" : needsYou > 0 || Boolean(liveRun);
  const statusLine = [
    liveRun ? `Run ${liveRun.run_no} ${liveRun.status}` : project.status,
    needsYou === 1 ? t("needsYouOne") : needsYou > 1 ? t("needsYou", { count: needsYou }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
  const sections = GROUP_SECTIONS[group];
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
    <div
      data-component="ProjectDetailView"
      data-active-group={group}
      className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6"
    >
      {/* ── Status: the desktop right rail; a collapsible section atop Overview on phone ── */}
      <aside
        data-component="ProjectStatus"
        aria-label={t("statusAria")}
        data-open={statusOpen ? "true" : "false"}
        className={`min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 lg:col-start-2 lg:row-start-1 lg:border-0 lg:bg-transparent lg:p-0 ${
          group === "overview" ? "" : "max-lg:hidden"
        }`}
      >
        <button
          type="button"
          data-action="toggle-project-status"
          aria-expanded={statusOpen}
          onClick={() => saveStatus(statusOpen ? "closed" : "open")}
          className="flex min-h-11 w-full items-center gap-2 text-left lg:hidden"
        >
          <span className="text-sm font-semibold">{t("status")}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">{statusLine}</span>
          <ChevronDownIcon
            aria-hidden
            className={`h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform ${statusOpen ? "rotate-180" : ""}`}
          />
        </button>
        <div className={`flex flex-col gap-3 ${statusOpen ? "mt-2 lg:mt-0" : "max-lg:hidden"}`}>
          <div data-component="ProjectStickyBars">
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
          <LiveStatusBar project={project} board={board} runnable={runnable} ownsNextStep={false} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
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
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-muted)]">
                  {meta}
                </span>
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

              {project.archived ? (
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  This project is archived — restore it (⋯) to run it again.
                </p>
              ) : null}
            </header>
          </div>
        </BusyRegion>

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

        <ProjectTabsNav active={group} onSelect={selectGroup} badges={tabBadges} />

        <div
          data-component="ProjectTabPanel"
          role="tabpanel"
          data-active-tab={tab}
          data-active-group={group}
          className="flex min-w-0 flex-col gap-6"
        >
          {sections.map((section) => {
            const Section = TAB_COMPONENT[section];
            return (
              <section
                key={section}
                id={`project-section-${section}`}
                data-section={section}
                className="flex min-w-0 scroll-mt-20 flex-col gap-2"
              >
                {sections.length > 1 ? (
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                    {PROJECT_TAB_LABEL[section]}
                  </h2>
                ) : null}
                <Section {...tabProps} />
              </section>
            );
          })}
          {group === "overview" && !project.archived ? (
            <AskOrChangeBox project={project} onChangeRequest={openChange} />
          ) : null}
        </div>
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

type StatusPref = "open" | "closed" | null;

const STATUS_OPEN_KEY = "aquarium.projects.statusOpen";

function parseStatusPref(raw: string): StatusPref {
  return raw === "open" || raw === "closed" ? raw : null;
}
