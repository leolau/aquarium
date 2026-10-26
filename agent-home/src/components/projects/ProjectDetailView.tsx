"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useState,
  useTransition,
  type ComponentType,
} from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { EditBriefSheet } from "@/components/projects/EditBriefSheet";
import { ProjectCategoryTag } from "@/components/projects/categories/ProjectCategoryTag";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";
import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import { ReadinessChecklist } from "@/components/projects/ReadinessChecklist";
import {
  extraFindings,
  isRunnable,
  readinessItems,
} from "@/components/projects/readiness";
import {
  agoLabel,
  dayDistance,
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
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectHealth,
  ProjectPlaybookResponse,
  ProjectUsage,
} from "@/types";

const HEALTH_TONE: Record<ProjectHealth, Tone> = {
  ok: "success",
  attention: "warning",
  stalled: "danger",
};

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
 * `/projects/[slug]` — the one place (§13): a sticky live status bar, an
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
  const router = useRouter();
  const { refresh, refreshing } = useRefresh();
  // Header writes: one lock each, held from the click until the refreshed
  // page (or the new run page) has landed.
  const runNowAction = useProjectAction<{
    run?: { run_no?: number };
    run_no?: number;
  }>();
  const activateAction = useProjectAction();
  const continueAction = useProjectAction();
  const [navigating, startNavigation] = useTransition();
  const headerBusy =
    runNowAction.busy ||
    activateAction.busy ||
    continueAction.busy ||
    navigating;
  const busy = headerBusy || refreshing;
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

  const readiness = readinessItems(project, playbook);
  const runnable = isRunnable(readiness);
  const findings = extraFindings(doctor, readiness);

  // §12 live updates: a run promoted in the background becomes visible
  // without a manual reload — the poller refreshes when the event head
  // moves (E3).
  useProjectEvents(project.slug);

  const waitingRun = project.runs.find((run) => run.status === "waiting");
  const openRun = project.runs.find(
    (run) => run.status === "running" || run.status === "waiting",
  );
  const blockedCards: ProjectBoardTask[] =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "blocked") ?? [];

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
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState<string | undefined>(undefined);
  const openChange = useCallback((initialText?: string) => {
    setChangeText(initialText);
    setChangeOpen(true);
  }, []);

  const triageCount =
    board?.columns
      .flatMap((column) => column.tasks)
      .filter((task) => task.status === "triage").length ?? 0;
  const tabBadges: Partial<Record<ProjectTab, number>> = {
    board: blockedCards.length + triageCount,
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

  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;

  // Run now lands on the run page so the live activity stream is the first
  // thing the user sees; the backend answers `{run: {run_no, …}, …}`.
  const runNow = () =>
    runNowAction.run(`${slugPath}/runs`, {
      skipRefresh: true,
      onSuccess: (data) => {
        const runNo = data.run?.run_no ?? data.run_no;
        if (typeof runNo === "number") {
          startNavigation(() =>
            router.push(
              `/projects/${encodeURIComponent(project.slug)}/runs/${runNo}`,
            ),
          );
        } else {
          refresh();
        }
      },
    });

  // Runs require status=active; the backend gate names whatever is missing
  // (outputs / members / profiles) in its 409 detail, shown under the header.
  const activate = () =>
    activateAction.run(slugPath, {
      method: "PATCH",
      body: { status: "active" },
    });

  const meta = [
    project.status,
    CADENCE_LABEL[project.cadence],
    project.schedule ?? undefined,
    project.next_run_at != null
      ? `next ${dayDistance(project.next_run_at)}`
      : undefined,
    project.autonomy,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div data-component="ProjectDetailView" className="flex flex-col gap-4">
      <BusyRegion
        busy={busy}
        label={busy ? "Talking to the agent…" : undefined}
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
            {project.goal ? (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {project.goal}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-[var(--color-muted)]">{meta}</p>
            {project.usage ? <ProjectUsageLine usage={project.usage} /> : null}
            {project.summary ? (
              <div
                data-component="ProjectSummary"
                className="mt-2 rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm"
              >
                <p className="italic">{project.summary}</p>
                {project.summary_at != null ? (
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Summarised {agoLabel(project.summary_at)}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {project.archived ? (
                <p className="text-sm text-[var(--color-muted)]">
                  This project is archived — restore it (⋯) to run it again.
                </p>
              ) : (
                <>
                  {project.status === "active" ? (
                    <ActionButton
                      data-action="run-now"
                      busy={runNowAction.busy || navigating}
                      pendingLabel="Starting run…"
                      onClick={() => void runNow()}
                      disabled={busy || !runnable || openRun !== undefined}
                      title={
                        openRun
                          ? `Run ${openRun.run_no} is still open — one run at a time.`
                          : runnable
                            ? undefined
                            : "See the checklist below."
                      }
                      className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                    >
                      Run now
                    </ActionButton>
                  ) : (
                    <ActionButton
                      data-action="activate"
                      busy={activateAction.busy}
                      pendingLabel="Activating…"
                      onClick={() => void activate()}
                      disabled={busy}
                      className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                    >
                      Activate
                    </ActionButton>
                  )}
                  {waitingRun ? (
                    <ActionButton
                      data-action="continue-run"
                      busy={continueAction.busy}
                      pendingLabel="Continuing…"
                      onClick={() =>
                        void continueAction.run(
                          `${slugPath}/runs/${waitingRun.run_no}/continue`,
                        )
                      }
                      disabled={busy}
                      className="rounded-xl border border-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent)] disabled:opacity-50"
                    >
                      Continue run {waitingRun.run_no}
                    </ActionButton>
                  ) : openRun ? (
                    <Link
                      href={`/projects/${encodeURIComponent(project.slug)}/runs/${openRun.run_no}`}
                      className="rounded-xl border border-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent)]"
                    >
                      Run {openRun.run_no} in progress
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Add
                  </button>
                  {canLead ? (
                    <button
                      type="button"
                      onClick={() => setEditOpen(true)}
                      className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setSummariseOpen(true)}
                    className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
                  >
                    {project.summary ? "Update summary" : "Summarise"}
                  </button>
                </>
              )}
            </div>

            {!project.archived ? (
              <ReadinessChecklist
                items={readiness}
                findings={findings}
                onActivate={() => void activate()}
                activating={activateAction.busy}
              />
            ) : null}

            <ActionError action={runNowAction} />
            <ActionError action={activateAction} />
            <ActionError action={continueAction} />
          </header>
        </div>
      </BusyRegion>

      {/* ── Live status: sticky, above every tab ───────────────── */}
      <LiveStatusBar project={project} board={board} />

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
