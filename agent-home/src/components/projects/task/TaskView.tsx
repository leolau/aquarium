"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useFileRefOpener } from "@/components/files/FileRefOpener";
import { AskOrChangeBox } from "@/components/projects/ask/AskOrChangeBox";
import { NeedsYouStrip, type StripItem } from "@/components/projects/board/NeedsYouStrip";
import { boardTasks, canActOnBoard, needsYou } from "@/components/projects/board/model";
import { useBoardContext } from "@/components/projects/board/useBoardContext";
import { ChangeRequestSheet } from "@/components/projects/changes/ChangeRequestSheet";
import { applyAcceptEnvelope } from "@/components/projects/envelopes";
import { LiveStatusBar } from "@/components/projects/live/LiveStatusBar";
import { liveState, openRunOf } from "@/components/projects/live/liveState";
import { DeliverableCard, type AcceptEnvelope } from "@/components/projects/outputs/DeliverableCard";
import { useProjectArtifacts } from "@/components/projects/outputs/useProjectArtifacts";
import { DRAFT_POLL_MS } from "@/components/projects/panels/PlanPanel";
import { ProjectLifecycleMenu } from "@/components/projects/ProjectLifecycleMenu";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useProjectEvents } from "@/components/projects/useProjectEvents";
import { useRunLive } from "@/components/projects/useRunLive";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useRefresh, useServerState } from "@/components/ui/useRefresh";
import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectOutputWithDeliveries,
  ProjectPlaybookDraftState,
  ProjectPlaybookResponse,
  ProjectRun,
  QuickTaskStartResponse,
} from "@/types";

import { checkInLabel } from "./viewMode";
import { TaskLiveCard } from "./TaskLiveCard";
import { TaskSummaryBar } from "./TaskSummaryBar";
import { PHASE_LABEL, planStepStates, queuedCardIds, taskPhase, taskPlan, type TaskPhase } from "./taskState";

const CARD = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3";
const BTN = "rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50";
const PRIMARY = "rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50";

const PHASE_TONE: Record<TaskPhase, string> = {
  planning: "text-sky-400",
  plan_review: "text-amber-400",
  ready: "text-amber-400",
  running: "text-sky-400",
  waiting: "text-amber-400",
  failed: "text-red-400",
  done: "text-emerald-400",
};

/**
 * Follow the agent's plan job while a task has no plan and no run yet. The
 * draft runs off the request thread and emits no project event, so this is
 * the plan panel's poll, stopped as soon as the job settles.
 */
function useTaskDraft(slug: string, active: boolean): ProjectPlaybookDraftState | null {
  const router = useRouter();
  const [draft, setDraft] = useState<ProjectPlaybookDraftState | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/playbook/draft`);
        if (!res.ok || cancelled) return;
        const state = (await res.json()) as ProjectPlaybookDraftState;
        if (cancelled) return;
        setDraft(state);
        if (state.status === "running" || (state.status === "done" && !state.launch && !state.rev)) {
          timer = setTimeout(() => void poll(), DRAFT_POLL_MS);
        } else if (state.status === "done") {
          router.refresh();
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), DRAFT_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug, active, router]);
  return active ? draft : null;
}

/**
 * A one-off project shown as a task: the request, the plan as a checklist
 * with the live step, what needs the person, then the result. The same
 * project, data and routes as Project mode; only the layout is simpler.
 */
export function TaskView({
  project,
  board,
  playbook,
  directives,
  callerUserId,
  isInstanceAdmin,
  onOpenProject,
}: {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  playbook: ProjectPlaybookResponse | null;
  directives: ProjectDirectivesResponse | null;
  callerUserId: string;
  isInstanceAdmin: boolean;
  onOpenProject: () => void;
}) {
  useProjectEvents(project.slug);
  const { refresh } = useRefresh();
  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;
  const callerRole = project.members.find((m) => m.user_id === callerUserId)?.role ?? null;
  const canLead = isInstanceAdmin || project.owner_user_id === callerUserId || callerRole === "lead";
  const canAct = !project.archived && (canLead || callerRole === "member");

  const noRunYet = project.runs.length === 0 && !playbook?.active;
  const draft = useTaskDraft(project.slug, noRunYet && !project.archived);
  const phase = taskPhase(project, playbook, draft);
  const plan = taskPlan(playbook);
  const open = openRunOf(project);
  // The open run's row (its cards' step keys and states), streamed once
  // here and handed to the live bar so it doesn't open a second stream.
  const [streamedRun, setStreamedRun] = useState<ProjectRun | null>(null);
  useRunLive(project.slug, open?.run_no ?? 0, open ? open.status : "done", setStreamedRun);
  const runDetail = streamedRun && open && streamedRun.run_no === open.run_no ? streamedRun : null;
  const live = liveState(project, board, { run: runDetail });
  // A run still "running" on paper but held on the person (a parked or
  // human-only card, a checkpoint) reads as Needs you, not Running.
  const statusPhase: TaskPhase = phase === "running" && live.kind === "needs_you" ? "waiting" : phase;
  const stepStates = planStepStates(
    plan?.steps?.map((s) => s.key) ?? [],
    phase,
    live.done,
    runDetail?.cards,
  );
  const latest = project.runs[0] ?? null;

  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState<string | undefined>(undefined);
  const openChange = (text?: string) => {
    setChangeText(text);
    setChangeOpen(true);
  };

  const stop = useProjectAction();
  const start = useProjectAction<QuickTaskStartResponse>();
  const cont = useProjectAction();

  const request = project.description || project.goal || project.name;

  return (
    <div data-component="TaskView" data-phase={statusPhase} className="grid gap-3 lg:grid-cols-[1fr_16rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <header data-component="TaskHeader" className={`${CARD} flex items-center gap-2`}>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{project.name}</h1>
          <span data-component="TaskStatus" className={`text-xs font-medium ${PHASE_TONE[statusPhase]}`}>
            ● {PHASE_LABEL[statusPhase]}
          </span>
          {open && canAct ? (
            <button
              type="button"
              disabled={stop.busy}
              onClick={() => void stop.run(`${slugPath}/runs/${open.run_no}/stop`)}
              className={BTN}
            >
              {stop.busy ? "Stopping…" : "■ Stop"}
            </button>
          ) : null}
        </header>

        <div data-component="TaskRequest" className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--color-accent)]/15 px-3 py-2 text-sm">
          {request}
        </div>

        <section data-component="TaskNeedsYou" aria-label="Needs you" className="flex flex-col gap-2">
          {phase === "plan_review" && plan ? (
            <NeedsCard title="Check the plan" body="The agent wrote a plan. Approve it to start, or tell the agent what to change.">
              {canAct ? (
                <>
                  <button
                    type="button"
                    disabled={start.busy}
                    onClick={() => void start.run(`${slugPath}/quick-task/start`)}
                    className={PRIMARY}
                  >
                    Approve
                  </button>
                  <button type="button" onClick={() => openChange()} className={BTN}>
                    Not these: tell the agent…
                  </button>
                </>
              ) : null}
            </NeedsCard>
          ) : null}
          {phase === "ready" ? (
            <NeedsCard title="Ready to start" body="The plan is approved, but the agent hasn't started. Nothing happens until it is started.">
              {canAct ? (
                <button
                  type="button"
                  disabled={start.busy}
                  onClick={() => void start.run(`${slugPath}/quick-task/start`)}
                  className={PRIMARY}
                >
                  {start.busy ? "Starting…" : "▶ Start task"}
                </button>
              ) : null}
            </NeedsCard>
          ) : null}
          {phase === "failed" ? (
            <NeedsCard
              title="This task stopped"
              body={latest?.error || latest?.summary || draft?.detail || (draft?.launch?.status === "failed" ? draft.launch.detail : "Something went wrong.")}
            >
              {canAct ? (
                <button
                  type="button"
                  disabled={start.busy}
                  onClick={() => void start.run(`${slugPath}/quick-task/start`)}
                  className={PRIMARY}
                >
                  {start.busy ? "Retrying…" : "Retry"}
                </button>
              ) : null}
            </NeedsCard>
          ) : null}
          {latest?.status === "waiting" ? (
            <NeedsCard title="The agent is waiting for you" body={latest.outcome || "Approve to let it carry on."}>
              {canAct ? (
                <>
                  <button
                    type="button"
                    disabled={cont.busy}
                    onClick={() => void cont.run(`${slugPath}/runs/${latest.run_no}/continue`)}
                    className={PRIMARY}
                  >
                    Approve
                  </button>
                  <button type="button" onClick={() => openChange()} className={BTN}>
                    Not these: tell the agent…
                  </button>
                  <button
                    type="button"
                    disabled={stop.busy}
                    onClick={() => void stop.run(`${slugPath}/runs/${latest.run_no}/stop`)}
                    className={BTN}
                  >
                    Stop the task
                  </button>
                </>
              ) : null}
            </NeedsCard>
          ) : null}
          {(project.clarify?.open_count ?? 0) > 0 ? (
            <NeedsCard title="The agent has a question" body="It can't carry on until someone answers.">
              <a href={`/projects/${encodeURIComponent(project.slug)}?view=project&tab=scope`} className={BTN}>
                Answer
              </a>
            </NeedsCard>
          ) : null}
          {phase === "running" ? (
            <TaskBoardNeeds project={project} board={board} callerUserId={callerUserId} canLead={canLead} />
          ) : null}
          {start.error || stop.error || cont.error ? (
            <p role="alert" className="text-xs text-red-400">
              {start.error || stop.error || cont.error}
            </p>
          ) : null}
        </section>

        {project.runs.length > 0 ? <TaskSummaryBar project={project} run={runDetail} /> : null}

        {phase === "done" ? (
          <TaskResult
            project={project}
            canAct={canAct}
            onChangeRequest={openChange}
            onOpenProject={onOpenProject}
            callerUserId={callerUserId}
            isInstanceAdmin={isInstanceAdmin}
          />
        ) : (
          <section data-component="TaskPlan" aria-label="Plan" className={CARD}>
            <h2 className="mb-2 text-sm font-semibold">Plan</h2>
            {plan?.steps && plan.steps.length > 0 ? (
              <ol className="flex flex-col gap-1.5 text-sm">
                {plan.steps.map((step, i) => {
                  const state = stepStates[i] ?? "todo";
                  return (
                    <li
                      key={step.key}
                      data-step={state}
                      aria-current={state === "current" ? "step" : undefined}
                      className={`flex items-start gap-2 ${
                        state === "current" ? "-mx-1.5 rounded-lg bg-sky-500/10 px-1.5 py-1 ring-1 ring-sky-500/30" : ""
                      }`}
                    >
                      <span aria-hidden className="w-4 shrink-0 text-center">
                        {state === "done" ? "✓" : state === "current" ? "◐" : "○"}
                      </span>
                      <span className={state === "todo" ? "text-[var(--color-muted)]" : undefined}>
                        {step.title}
                        {state === "current" ? (
                          <span data-component="TaskLiveLine" className="block text-xs text-sky-400">
                            {live.label}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                {phase === "failed" ? "The agent couldn't write a plan." : "The agent is writing the plan…"}
              </p>
            )}
          </section>
        )}

        {live.running.length > 0 ? (
          <div data-component="TaskLiveCards" className="flex flex-col gap-2">
            {live.running.map((task) => (
              <TaskLiveCard key={task.id} slug={project.slug} task={task} />
            ))}
          </div>
        ) : null}

        {open && open.status !== "waiting" ? (
          <LiveStatusBar project={project} board={board} run={runDetail} streamRun={false} showTaskRows={false} />
        ) : null}


        {!project.archived ? (
          <AskOrChangeBox project={project} onChangeRequest={openChange} />
        ) : null}
      </div>

      <TaskDetails project={project} onOpenProject={onOpenProject} />

      {changeOpen ? (
        <ChangeRequestSheet
          project={project}
          playbook={playbook}
          directives={directives}
          initialText={changeText}
          onEditPlan={onOpenProject}
          onClose={() => {
            setChangeOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function NeedsCard({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div data-component="TaskNeedsCard" className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-xs text-[var(--color-muted)]">{body}</p>
      {children ? <div className="mt-2 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

/** The board's own Needs-you cards (approve / tell the agent / stop), as Project mode's Board shows them. */
function TaskBoardNeeds({
  project,
  board,
  callerUserId,
  canLead,
}: {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  callerUserId: string;
  canLead: boolean;
}) {
  const [liveBoard, setLiveBoard] = useServerState(board);
  const context = useBoardContext(project.slug, board);
  const [held, setHeld] = useState<Record<string, ProjectBoardTask>>({});
  const memberIds = useMemo(() => new Set(project.members.map((m) => m.user_id)), [project.members]);
  const profiles = useMemo(
    () =>
      [...new Set([project.host_profile, ...project.profiles.map((p) => p.profile)])].filter(
        (p): p is string => !!p,
      ),
    [project.host_profile, project.profiles],
  );
  const [mountedAt] = useState(() => Math.floor(Date.now() / 1000));
  if (!liveBoard) return null;
  const tasks = boardTasks(liveBoard).filter((t) => t.project_id == null || t.project_id === project.id);
  const live = new Map(tasks.map((t) => [t.id, t]));
  const source = tasks.filter((t) => !held[t.id]).concat(Object.values(held));
  const queued = queuedCardIds(context?.open_run);
  const items: StripItem[] = needsYou(source)
    .filter((item) => !(item.task.status === "triage" && queued.has(item.task.id)))
    .map((item) => ({ ...item, live: live.get(item.task.id) ?? null }));
  if (items.length === 0) return null;
  return (
    <NeedsYouStrip
      slug={project.slug}
      items={items}
      canAct={canActOnBoard(project, callerUserId, canLead)}
      profiles={profiles}
      memberIds={memberIds}
      cardRuns={context?.card_runs ?? {}}
      now={liveBoard.now ?? mountedAt}
      update={(fn) => setLiveBoard((prev) => (prev ? fn(prev) : prev))}
      onHold={(task) => setHeld((h) => (h[task.id] ? h : { ...h, [task.id]: task }))}
      onRelease={(taskId) =>
        setHeld((h) => {
          if (!h[taskId]) return h;
          const next = { ...h };
          delete next[taskId];
          return next;
        })
      }
    />
  );
}

function TaskDetails({ project, onOpenProject }: { project: ProjectDetail; onOpenProject: () => void }) {
  const timeLabel = useTimeLabel();
  const starter = project.owner_user_id ?? "—";
  const usage = project.usage;
  const cost = usage
    ? [
        `${usage.runs} ${usage.runs === 1 ? "run" : "runs"}`,
        usage.tokens ? `${usage.tokens.total.toLocaleString("en")} tokens` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "—";
  return (
    <aside data-component="TaskDetails" aria-label="Details" className={`${CARD} h-fit text-xs`}>
      <h2 className="mb-2 text-sm font-semibold">Details</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-[var(--color-muted)]">Started by</dt>
        <dd>
          {starter} · {timeLabel(project.created_at, "ago")}
        </dd>
        <dt className="text-[var(--color-muted)]">Profile</dt>
        <dd>{project.profiles.find((pr) => pr.role === "host")?.profile ?? project.host_profile ?? "—"}</dd>
        <dt className="text-[var(--color-muted)]">Check in</dt>
        <dd>{checkInLabel(project.autonomy)}</dd>
        <dt className="text-[var(--color-muted)]">Cost</dt>
        <dd>{cost}</dd>
      </dl>
      <button type="button" onClick={onOpenProject} className="mt-3 text-[var(--color-accent)]">
        Open in Project mode →
      </button>
    </aside>
  );
}

function TaskResult({
  project,
  canAct,
  onChangeRequest,
  onOpenProject,
  callerUserId,
  isInstanceAdmin,
}: {
  project: ProjectDetail;
  canAct: boolean;
  onChangeRequest: (text?: string) => void;
  onOpenProject: () => void;
  callerUserId: string;
  isInstanceAdmin: boolean;
}) {
  const timeLabel = useTimeLabel();
  const [outputs, setOutputs] = useServerState(project.outputs);
  const files = useProjectArtifacts(project.slug, outputs);
  const opener = useFileRefOpener();
  const again = useProjectAction();
  const acceptAll = useProjectAction<AcceptEnvelope>();
  const repeat = useProjectAction();
  const scheduleAction = useProjectAction();
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [schedule, setSchedule] = useState("every 1d");
  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;
  const latest = project.runs[0] ?? null;
  const shown = outputs.filter((o) => o.status !== "dropped");

  const onAccepted = (outputId: string, envelope: AcceptEnvelope) =>
    setOutputs((prev) => applyAcceptEnvelope(prev, outputId, envelope).outputs);
  const onUpdated = (row: Partial<ProjectOutputWithDeliveries> & { id: string }) => {
    const { deliveries: _ignored, ...rest } = row;
    void _ignored;
    setOutputs((prev) => prev.map((o) => (o.id === row.id ? { ...o, ...rest } : o)));
  };

  const waitingOnYou = outputs.filter((o) => o.status === "delivered");
  const acceptResult = async () => {
    for (const output of waitingOnYou) {
      await acceptAll.run(`${slugPath}/outputs/${encodeURIComponent(output.id)}/accept`, {
        skipRefresh: true,
        onSuccess: (data) => onAccepted(output.id, data),
      });
    }
  };

  const makeRepeatable = async () => {
    const value = schedule.trim();
    if (!value) return;
    const patched = await repeat.run(slugPath, {
      method: "PATCH",
      body: { cadence: "repeatable" },
      skipRefresh: true,
    });
    if (!patched?.ok) return;
    const saved = await scheduleAction.run(`${slugPath}/schedule`, {
      method: "PUT",
      body: { schedule: value },
      skipRefresh: true,
    });
    if (saved?.ok) onOpenProject();
  };

  return (
    <section data-component="TaskResult" aria-label="Result" className="flex flex-col gap-3">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
        {latest?.summary || "Done. The result is below."}
      </div>
      <ul className="flex flex-col gap-3">
      {shown.map((output) => (
        <DeliverableCard
          key={output.id}
          slug={project.slug}
          output={output}
          artifacts={files.artifacts}
          archived={project.archived}
          onAccepted={onAccepted}
          onUpdated={onUpdated}
          onRemoved={(id) => setOutputs((prev) => prev.filter((o) => o.id !== id))}
          onChangeRequest={onChangeRequest}
          onOpenFile={opener.open}
          onDownloadFile={opener.download}
          resolving={opener.resolving}
        />
      ))}
      </ul>
      {canAct ? (
        <div data-component="TaskResultActions" className="flex flex-wrap items-center gap-2">
          {waitingOnYou.length > 0 ? (
            <button type="button" disabled={acceptAll.busy} onClick={() => void acceptResult()} className={PRIMARY}>
              {acceptAll.busy ? "Accepting…" : "✓ Accept result"}
            </button>
          ) : null}
          <button type="button" onClick={() => onChangeRequest()} className={BTN}>
            Ask for changes
          </button>
          <button
            type="button"
            disabled={again.busy}
            onClick={() => void again.run(`${slugPath}/runs`)}
            className={BTN}
          >
            {again.busy ? "Starting…" : "↻ Run again"}
          </button>
          <button type="button" aria-expanded={repeatOpen} onClick={() => setRepeatOpen((v) => !v)} className={BTN}>
            Repeat every…
          </button>
        </div>
      ) : null}
      {repeatOpen && canAct ? (
        <form
          data-component="TaskRepeat"
          onSubmit={(e) => {
            e.preventDefault();
            void makeRepeatable();
          }}
          className={`${CARD} flex flex-wrap items-center gap-2 text-xs`}
        >
          <label htmlFor="task-repeat">Repeat</label>
          <input
            id="task-repeat"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1"
          />
          <button type="submit" disabled={repeat.busy || scheduleAction.busy || !schedule.trim()} className={PRIMARY}>
            Make it repeat
          </button>
          <span className="text-[var(--color-muted)]">It becomes a repeating project and moves to Project mode.</span>
        </form>
      ) : null}
      {again.error || acceptAll.error || repeat.error || scheduleAction.error ? (
        <p role="alert" className="text-xs text-red-400">
          {again.error || acceptAll.error || repeat.error || scheduleAction.error}
        </p>
      ) : null}
      <details data-component="TaskHistory" className={`${CARD} text-sm`}>
        <summary className="cursor-pointer font-medium">What the agent did</summary>
        <ol className="mt-2 flex flex-col gap-1 text-xs">
          {project.runs.map((run) => (
            <li key={run.run_no}>
              Run {run.run_no} · {run.status} · {timeLabel(run.started_at, "ago")}
              {run.outcome ? ` — ${run.outcome}` : ""}
            </li>
          ))}
        </ol>
      </details>
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <span>Archive, restore or delete:</span>
        <ProjectLifecycleMenu project={project} callerUserId={callerUserId} isInstanceAdmin={isInstanceAdmin} />
      </div>
      {opener.dialog}
    </section>
  );
}
