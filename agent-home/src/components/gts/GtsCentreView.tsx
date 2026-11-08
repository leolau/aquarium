"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { AdvancedSwitch, useAdvanced } from "@/components/system/Advanced";
import { useT } from "@/i18n/client";

import type {
  GtsEvaluationMethod,
  GtsGoal,
  GtsGraphResponse,
  GtsItemGrant,
  GtsSkill,
  GtsTask,
} from "@/types";

/**
 * FG-20 Wave B1 — mobile-first Graph, formerly GTS Centre (read-only, C9).
 * Raw states, visibility, evaluation methods and the assignment scheme sit
 * behind Advanced (off by default).
 *
 * Renders the C2-scoped goal→task→skill graph the Python API returns from
 * `/api/gts/graph`: goal/task hierarchy, engine-computed 0–100 scores,
 * per-node observe/measure evaluation method, and FG-19 assignment (assignee +
 * read-only watcher count). It is the mobile face of `web/`'s `GtsCentrePage`;
 * like that panel it is **read-only** — creation/scoring/assignment stay on the
 * CLI/agent authority paths (no HTTP write API exists), so this surface never
 * mutates the graph. Server-rendered; the browser only ever gets scoped rows.
 */

/** Whether the engineer-facing detail is shown. */
const AdvancedContext = createContext(false);

/** Maps derived once from the M:N edges so nodes render their linked children. */
interface GraphIndex {
  tasksById: Map<string, GtsTask>;
  skillsById: Map<string, GtsSkill>;
  tasksByGoal: Map<string, string[]>;
  skillsByTask: Map<string, string[]>;
  subGoalsByParent: Map<string, GtsGoal[]>;
}

type Tone = "accent" | "success" | "warning" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  accent: "bg-[var(--color-accent)] text-[var(--color-accent-fg)]",
  success: "bg-emerald-500/15 text-emerald-300",
  warning: "bg-amber-500/15 text-[var(--color-warn-text)]",
  muted: "bg-[var(--color-surface-2)] text-[var(--color-fg)]",
};

const PRIORITY_TONE: Record<string, Tone> = {
  high: "warning",
  medium: "muted",
  low: "muted",
};

function GtsBadge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      data-component="GtsBadge"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) {
    return <GtsBadge tone="muted">no score</GtsBadge>;
  }
  const tone: Tone = score >= 66 ? "success" : score >= 33 ? "warning" : "muted";
  return <GtsBadge tone={tone}>{Math.round(score)}</GtsBadge>;
}

/** Active assignee + read-only watcher count (grants are pending/accepted). */
function AssignmentBadges({
  assigneeUserId,
  grants,
}: {
  assigneeUserId: string | null;
  grants: GtsItemGrant[];
}) {
  const active = grants.filter(
    (g) => g.status === "accepted" || g.status === "pending",
  );
  const watchers = active.filter((g) => g.grant === "watcher");
  if (!assigneeUserId && watchers.length === 0) return null;
  return (
    <>
      {assigneeUserId ? (
        <GtsBadge tone="accent">@{assigneeUserId}</GtsBadge>
      ) : null}
      {watchers.length > 0 ? (
        <GtsBadge tone="muted">
          {watchers.length} watching
        </GtsBadge>
      ) : null}
    </>
  );
}

function MethodLine({ method }: { method: GtsEvaluationMethod }) {
  if (!method.observation && !method.scoring_prompt && !method.set_by_user_id) {
    return (
      <p className="text-xs text-[var(--color-muted)]">No evaluation method set.</p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
      <div className="flex flex-wrap items-center gap-2">
        <GtsBadge tone={method.measurable ? "success" : "muted"}>
          {method.measurable ? "measurable" : "qualitative"}
        </GtsBadge>
        {method.locked ? <GtsBadge tone="muted">locked</GtsBadge> : null}
        {method.observation ? <span>observe via {method.observation.source}</span> : null}
      </div>
      {method.observation?.prompt ? (
        <p>
          <span className="font-medium text-[var(--color-fg)]">Observe:</span>{" "}
          {method.observation.prompt}
        </p>
      ) : null}
      {method.scoring_prompt ? (
        <p>
          <span className="font-medium text-[var(--color-fg)]">Score:</span>{" "}
          {method.scoring_prompt}
        </p>
      ) : null}
    </div>
  );
}

function TaskRow({ task, index }: { task: GtsTask; index: GraphIndex }) {
  const advanced = useContext(AdvancedContext);
  const linkedSkills = (index.skillsByTask.get(task.id) ?? [])
    .map((sid) => index.skillsById.get(sid))
    .filter((s): s is GtsSkill => Boolean(s));
  return (
    <div data-component="TaskRow" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{task.title}</span>
        <GtsBadge tone={PRIORITY_TONE[task.priority] ?? "muted"}>
          {task.priority}
        </GtsBadge>
        {advanced ? <GtsBadge tone="muted">{task.current_state}</GtsBadge> : null}
        <AssignmentBadges
          assigneeUserId={task.assignee_user_id}
          grants={task.grants}
        />
        <ScoreBadge score={task.score} />
      </div>
      {advanced ? (
        <div className="pl-3">
          <MethodLine method={task.evaluation_method} />
        </div>
      ) : null}
      {linkedSkills.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 pl-3 text-xs text-[var(--color-muted)]">
          {linkedSkills.map((s) => (
            <GtsBadge key={s.id} tone="muted">
              {s.name}
            </GtsBadge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Tasks shown per goal before "Show more" (expands in place). */
const TASK_PREVIEW = 3;

function GoalCard({
  goal,
  index,
  depth,
}: {
  goal: GtsGoal;
  index: GraphIndex;
  depth: number;
}) {
  const linkedTasks = (index.tasksByGoal.get(goal.id) ?? [])
    .map((tid) => index.tasksById.get(tid))
    .filter((t): t is GtsTask => Boolean(t));
  const childGoals = index.subGoalsByParent.get(goal.id) ?? [];
  const advanced = useContext(AdvancedContext);
  const t = useT("system");
  const [allTasks, setAllTasks] = useState(false);
  const shownTasks = allTasks ? linkedTasks : linkedTasks.slice(0, TASK_PREVIEW);
  return (
    <div
      data-component="GoalCard"
      className={`min-w-0 rounded-[var(--radius-xl)] border border-[var(--color-border)] p-4 ${
        depth > 0 ? "ml-2 bg-[var(--color-surface-2)] sm:ml-3" : "bg-[var(--color-surface)]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{goal.title}</span>
          <GtsBadge tone={PRIORITY_TONE[goal.priority] ?? "muted"}>
            {goal.priority}
          </GtsBadge>
          <GtsBadge tone="muted">{goal.status}</GtsBadge>
          {advanced ? <GtsBadge tone="muted">{goal.level}</GtsBadge> : null}
          {advanced ? <GtsBadge tone="muted">{goal.visibility}</GtsBadge> : null}
          <AssignmentBadges
            assigneeUserId={goal.assignee_user_id}
            grants={goal.grants}
          />
        </div>
        <ScoreBadge score={goal.score} />
      </div>

      {advanced ? (
        <div className="mt-2">
          <MethodLine method={goal.evaluation_method} />
        </div>
      ) : null}

      {linkedTasks.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2 border-l border-[var(--color-border)] pl-3">
          {shownTasks.map((task) => (
            <TaskRow key={task.id} task={task} index={index} />
          ))}
          {linkedTasks.length > TASK_PREVIEW ? (
            <button
              type="button"
              data-action="toggle-tasks"
              aria-expanded={allTasks}
              onClick={() => setAllTasks((v) => !v)}
              className="inline-flex min-h-11 items-center self-start text-sm font-medium text-[var(--color-accent)] hover:underline"
            >
              {allTasks ? t("graph.hideTasks") : t("graph.showTasks", { count: linkedTasks.length - TASK_PREVIEW })}
            </button>
          ) : null}
        </div>
      ) : null}

      {childGoals.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {childGoals.map((child) => (
            <GoalCard key={child.id} goal={child} index={index} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildIndex(graph: GtsGraphResponse): GraphIndex {
  const tasksById = new Map(graph.tasks.map((t) => [t.id, t] as const));
  const skillsById = new Map(graph.skills.map((s) => [s.id, s] as const));
  const tasksByGoal = new Map<string, string[]>();
  for (const { goal_id, task_id } of graph.task_goals) {
    const arr = tasksByGoal.get(goal_id) ?? [];
    arr.push(task_id);
    tasksByGoal.set(goal_id, arr);
  }
  const skillsByTask = new Map<string, string[]>();
  for (const { task_id, skill_id } of graph.task_skills) {
    const arr = skillsByTask.get(task_id) ?? [];
    arr.push(skill_id);
    skillsByTask.set(task_id, arr);
  }
  const subGoalsByParent = new Map<string, GtsGoal[]>();
  for (const goal of graph.goals) {
    if (goal.level !== "top" && goal.parent_goal_id) {
      const arr = subGoalsByParent.get(goal.parent_goal_id) ?? [];
      arr.push(goal);
      subGoalsByParent.set(goal.parent_goal_id, arr);
    }
  }
  return { tasksById, skillsById, tasksByGoal, skillsByTask, subGoalsByParent };
}

function InfoCard({ children }: { children: ReactNode }) {
  return (
    <div
      data-component="GtsInfoCard"
      className="rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border)] p-5 text-sm text-[var(--color-muted)]"
    >
      {children}
    </div>
  );
}

export function GtsCentreView({
  graph,
  initialAdvanced = false,
}: {
  graph: GtsGraphResponse;
  initialAdvanced?: boolean;
}) {
  const t = useT("system");
  const [advanced, setAdvanced] = useAdvanced("graph", initialAdvanced);

  if (!graph.configured) {
    const [before, rest] = t("graph.notConfigured").split("{dsn}");
    const [middle, after] = (rest ?? "").split("{cmd}");
    return (
      <div data-component="GtsCentreView" className="flex flex-col gap-4 pb-24 lg:pb-8">
        <InfoCard>
          {before}
          <code>datastore.supabase_app.dsn</code>
          {middle}
          <code>hermes goal</code>
          {after}
        </InfoCard>
      </div>
    );
  }

  const index = buildIndex(graph);
  const topGoals = graph.goals.filter((g) => g.level === "top");

  return (
    <AdvancedContext.Provider value={advanced}>
      <div data-component="GtsCentreView" className="flex flex-col gap-3 pb-24 lg:pb-8">
        <div className="flex justify-end">
          <AdvancedSwitch on={advanced} onChange={setAdvanced} />
        </div>
        {topGoals.length === 0 ? (
          <InfoCard>{t("graph.empty")}</InfoCard>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
            {topGoals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} index={index} depth={0} />
            ))}
          </div>
        )}
        <p className="text-xs text-[var(--color-muted)]">
          {t("graph.readOnly", {
            scheme: advanced ? graph.assignment.scheme : graph.assignment.scheme.replace(/-/g, " "),
            watchers: graph.assignment.enabled ? t("graph.watchers") : "",
          })}
        </p>
      </div>
    </AdvancedContext.Provider>
  );
}
