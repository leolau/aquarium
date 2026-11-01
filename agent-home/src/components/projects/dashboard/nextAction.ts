import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectTab } from "@/components/projects/tabs/types";
import {
  agentTriageCards,
  allOutputsAccepted,
  awaitingAcceptance,
  blockedCards,
  boardTasks,
  clarifyOf,
  firstUnmet,
  hasInputs,
  latestRun,
  nowSeconds,
  openRun,
  plural,
  quoteTitles,
  runStalled,
  runsNewestFirst,
  spanLabel,
  suggestScopeFirst,
} from "@/components/projects/dashboard/derive";
import type {
  PlaybookStep,
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectPlaybookResponse,
} from "@/types";

/**
 * What one Dashboard button does. Mutations (`continue_run`, `resume_run`,
 * `approve_cards`, `start_run`, `unblock_card`, `activate`, `mark_done`) are
 * fired through `useProjectAction`; the rest only move the person somewhere.
 */
export type DashIntent =
  | { kind: "continue_run"; runNo: number }
  | { kind: "resume_run"; runNo: number }
  | { kind: "approve_cards"; taskIds: string[]; startRun: boolean }
  | { kind: "start_run" }
  | { kind: "unblock_card"; taskId: string }
  | { kind: "activate" }
  | { kind: "mark_done" }
  | { kind: "navigate"; tab: ProjectTab }
  | { kind: "open_run"; runNo: number }
  | { kind: "open_card"; taskId: string }
  | { kind: "change_request" };

export interface DashAction {
  label: string;
  /** What the button says while in flight (mutations only). */
  pendingLabel?: string;
  /** One line saying exactly what clicking it does. */
  effect: string;
  intent: DashIntent;
}

const MUTATIONS = new Set<DashIntent["kind"]>([
  "continue_run",
  "resume_run",
  "approve_cards",
  "start_run",
  "unblock_card",
  "activate",
  "mark_done",
]);

export function isMutation(intent: DashIntent): boolean {
  return MUTATIONS.has(intent.kind);
}

export type NeedsYouGroup =
  | "run"
  | "triage"
  | "scope"
  | "blocked"
  | "outputs"
  | "inputs"
  | "readiness";

/** Rank order of the groups — the brief's (a) → (f), scope after triage. */
export const NEEDS_YOU_ORDER: NeedsYouGroup[] = [
  "run",
  "triage",
  "scope",
  "blocked",
  "outputs",
  "inputs",
  "readiness",
];

export type DashTone = "danger" | "warning" | "accent" | "info" | "calm";

export interface NeedsYouItem {
  key: string;
  group: NeedsYouGroup;
  tone: DashTone;
  title: string;
  detail: string;
  action: DashAction;
  secondary?: DashAction;
}

export type NextActionState =
  | "waiting"
  | "stalled"
  | "failed"
  | "needs_you"
  | "working"
  | "idle"
  | "ready"
  | "done"
  | "archived";

export interface NextAction {
  key: string;
  state: NextActionState;
  tone: DashTone;
  headline: string;
  why: string;
  primary: DashAction;
  secondary: DashAction | null;
  /** True whenever a person has to do something for work to move. */
  needsPerson: boolean;
}

export interface DashboardInput {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  readiness: ReadinessItem[];
  playbook: ProjectPlaybookResponse | null;
  /** Owner, lead or box admin — who may steer the project. Defaults to true. */
  canLead?: boolean;
  /** Epoch seconds; injectable for tests. */
  now?: number;
}

const CHANGE: DashAction = {
  label: "Tell the agent what to change",
  effect: "Opens the change box. Nothing runs until you confirm.",
  intent: { kind: "change_request" },
};

function openRunAction(runNo: number, label: string): DashAction {
  return {
    label,
    effect: `Opens run ${runNo}'s page.`,
    intent: { kind: "open_run", runNo },
  };
}

function startRunAction(project: ProjectDetail, playbook: ProjectPlaybookResponse | null): DashAction {
  const next = (latestRun(project)?.run_no ?? 0) + 1;
  const rev = playbook?.active?.rev;
  return {
    label: `Start iteration ${next}`,
    pendingLabel: "Starting…",
    effect: `Starts run ${next}${rev != null ? ` with plan rev ${rev}` : ""}.`,
    intent: { kind: "start_run" },
  };
}

const READINESS_FIX: Record<
  ReadinessItem["key"],
  { title: string; label: string }
> = {
  outputs: { title: "Say what this project delivers", label: "Add an output" },
  profile: { title: "Pick a profile to run on", label: "Open Settings" },
  plan: { title: "The project has no plan to follow", label: "Open the plan" },
  status: { title: "Activate the project", label: "Activate" },
  schedule: { title: "Set a schedule", label: "Open Settings" },
};

const OPEN_SCOPE: DashAction = {
  label: "Open Scope",
  effect: "Opens the Scope tab.",
  intent: { kind: "navigate", tab: "scope" },
};

/**
 * The scope conversation, when it waits on a person: questions to answer,
 * an understanding to confirm, or — before any plan or run exists — the
 * suggestion to let the agent ask first. A soft gate: drafting the plan
 * directly is always offered beside it.
 */
function scopeItem(
  project: ProjectDetail,
  playbook: ProjectPlaybookResponse | null,
  canLead: boolean,
): NeedsYouItem | null {
  const clarify = clarifyOf(project);
  if (clarify.status === "open") {
    const n = Math.max(1, clarify.open_count);
    return {
      key: "scope:open",
      group: "scope",
      tone: "accent",
      title: `The agent has ${plural(n, "question")} about scope`,
      detail: "Answer or skip them; the plan is drafted from what you say.",
      action: { ...OPEN_SCOPE, label: n === 1 ? "Answer it" : "Answer them" },
    };
  }
  if (clarify.status === "answered") {
    return {
      key: "scope:answered",
      group: "scope",
      tone: "accent",
      title: "Confirm the agent's understanding",
      detail: "Every question is answered or skipped. Check its summary of the goal and scope.",
      action: { ...OPEN_SCOPE, label: "Review and confirm" },
    };
  }
  if (canLead && suggestScopeFirst(project, playbook)) {
    return {
      key: "scope:start",
      group: "scope",
      tone: "accent",
      title: "Let the agent ask about scope first",
      detail: "It reads the brief and your inputs, then checks the goal, audience and format with you before it plans.",
      action: {
        label: "Let the agent ask",
        effect: "Opens Scope, where the agent asks 3–7 questions about the goal and scope. Nothing runs.",
        intent: { kind: "navigate", tab: "scope" },
      },
      secondary: {
        label: "Draft the plan directly",
        effect: "Opens the Plan tab.",
        intent: { kind: "navigate", tab: "plan" },
      },
    };
  }
  return null;
}

function readinessItem(item: ReadinessItem): NeedsYouItem {
  const fix = READINESS_FIX[item.key];
  if (item.key === "status") {
    return {
      key: "readiness:status",
      group: "readiness",
      tone: "accent",
      title: fix.title,
      detail: "Runs can only start once it is active.",
      action: {
        label: fix.label,
        pendingLabel: "Activating…",
        effect: "Sets the project to Active so runs can start.",
        intent: { kind: "activate" },
      },
    };
  }
  const tab: ProjectTab = item.tab ?? "settings";
  const title =
    item.key === "plan" && /waiting/.test(item.hint)
      ? "A plan revision is waiting for you"
      : fix.title;
  return {
    key: `readiness:${item.key}`,
    group: "readiness",
    tone: "accent",
    title,
    detail: item.hint,
    action: {
      label: item.key === "plan" && /waiting/.test(item.hint) ? "Review the plan" : fix.label,
      effect: `Opens the ${tab[0].toUpperCase()}${tab.slice(1)} tab.`,
      intent: { kind: "navigate", tab },
    },
  };
}

function stallWhy(
  project: ProjectDetail,
  board: ProjectBoardView | null,
  startedAt: number,
  now: number,
): string {
  const blocked = blockedCards(board);
  const triage = agentTriageCards(project, board);
  if (triage.length > 0) {
    return `${quoteTitles(triage.map((t) => t.title))} ${triage.length === 1 ? "is" : "are"} waiting in Triage, so no worker can pick ${triage.length === 1 ? "it" : "them"} up.`;
  }
  if (blocked.length > 0) {
    return `${plural(blocked.length, "blocked card")} ${blocked.length === 1 ? "is" : "are"} holding it up, and no worker is active.`;
  }
  return `No worker is active on it. It started ${spanLabel(now - startedAt)} ago.`;
}

/**
 * Everything a person must act on right now, ranked (a) a waiting, stalled
 * or failed run → (b) the agent's cards waiting in Triage → scope questions
 * or the understanding to confirm → (c) blocked cards → (d) delivered
 * outputs to accept → (e) no inputs → (f) the first unmet readiness item.
 */
export function needsYouItems({
  project,
  board,
  readiness,
  playbook,
  canLead = true,
  now = nowSeconds(),
}: DashboardInput): NeedsYouItem[] {
  if (project.archived) return [];
  const items: NeedsYouItem[] = [];
  const open = openRun(project);
  const runs = runsNewestFirst(project);

  // (a) runs
  for (const run of runs.filter((r) => r.status === "waiting")) {
    items.push({
      key: `run:waiting:${run.run_no}`,
      group: "run",
      tone: "warning",
      title: `Run ${run.run_no} is waiting for you at a checkpoint`,
      detail: "The agent paused for your review before going on.",
      action: {
        label: `Continue run ${run.run_no}`,
        pendingLabel: "Continuing…",
        effect: `Lets run ${run.run_no} go on past its checkpoint.`,
        intent: { kind: "continue_run", runNo: run.run_no },
      },
      secondary: openRunAction(run.run_no, "Review it first"),
    });
  }
  const stalled = runs.filter((r) => runStalled(r, board, now));
  for (const run of stalled) {
    items.push({
      key: `run:stalled:${run.run_no}`,
      group: "run",
      tone: "danger",
      title: `Run ${run.run_no} has stalled`,
      detail: stallWhy(project, board, run.started_at, now),
      action: openRunAction(run.run_no, `See why run ${run.run_no} stalled`),
      secondary: CHANGE,
    });
  }
  const latest = runs[0];
  if (
    !open &&
    latest &&
    (latest.status === "failed" || latest.status === "blocked")
  ) {
    items.push({
      key: `run:failed:${latest.run_no}`,
      group: "run",
      tone: "danger",
      title: `Run ${latest.run_no} ${latest.status === "failed" ? "failed" : "is blocked"}`,
      detail: latest.outcome?.trim() || "It stopped before finishing its plan.",
      action: {
        label: `Resume run ${latest.run_no}`,
        pendingLabel: "Resuming…",
        effect: `Picks run ${latest.run_no} up from where its cards stopped.`,
        intent: { kind: "resume_run", runNo: latest.run_no },
      },
      secondary: openRunAction(latest.run_no, "See what went wrong"),
    });
  }

  // (b) the agent's triage cards
  const triage = agentTriageCards(project, board);
  if (triage.length > 0) {
    const runnable = readiness.every((item) => item.ok);
    const startRun = !open && runnable && project.status === "active";
    const resumes = startRun || open !== null;
    const nextRun = (latest?.run_no ?? 0) + 1;
    const n = triage.length;
    items.push({
      key: "triage",
      group: "triage",
      tone: "warning",
      title: `Approve ${plural(n, "new card")} so work can continue`,
      detail: `The agent created ${quoteTitles(triage.map((t) => t.title))}, but ${n === 1 ? "it is" : "they are"} waiting in Triage, so no worker can pick ${n === 1 ? "it" : "them"} up.`,
      action: {
        label: `Approve ${plural(n, "card")}${resumes ? " & resume work" : ""}`,
        pendingLabel: "Approving…",
        effect: startRun
          ? `Moves ${plural(n, "card")} to Ready, then starts run ${nextRun}.`
          : `Moves ${plural(n, "card")} to Ready${open ? ` so run ${open.run_no} can pick ${n === 1 ? "it" : "them"} up` : ""}.`,
        intent: {
          kind: "approve_cards",
          taskIds: triage.map((t) => t.id),
          startRun,
        },
      },
      secondary: {
        label: "Review them first",
        effect: "Opens the Board tab.",
        intent: { kind: "navigate", tab: "board" },
      },
    });
  }

  // scope: questions to answer, an understanding to confirm, or ask first
  const scope = scopeItem(project, playbook, canLead);
  if (scope) items.push(scope);

  // (c) blocked cards
  for (const card of blockedCards(board)) items.push(blockedItem(card));

  if (project.status !== "done") {
    // (d) outputs to accept
    const awaiting = awaitingAcceptance(project);
    if (awaiting > 0) {
      items.push({
        key: "outputs",
        group: "outputs",
        tone: "info",
        title: `${plural(awaiting, "delivered output")} ${awaiting === 1 ? "isn't" : "aren't"} accepted yet`,
        detail: "Accept them, or tell the agent what to change.",
        action: {
          label: "Review outputs",
          effect: "Opens the Outputs tab.",
          intent: { kind: "navigate", tab: "outputs" },
        },
      });
    }

    // (e) inputs
    if (!hasInputs(project)) {
      items.push({
        key: "inputs",
        group: "inputs",
        tone: "info",
        title: "No inputs attached",
        detail: "Templates, earlier work or notes help the agent get it right.",
        action: {
          label: "Add inputs",
          effect: "Opens the Inputs tab.",
          intent: { kind: "navigate", tab: "inputs" },
        },
        // Inputs are optional: when nothing else blocks a run, keep starting one a click away.
        ...(!open && project.status === "active" && readiness.every((item) => item.ok)
          ? { secondary: startRunAction(project, playbook) }
          : {}),
      });
    }

    // (f) first unmet readiness item
    const unmet = firstUnmet(readiness);
    if (unmet) items.push(readinessItem(unmet));
  }

  return items;
}

function blockedItem(card: ProjectBoardTask): NeedsYouItem {
  const base = {
    key: `blocked:${card.id}`,
    group: "blocked" as const,
    tone: "danger" as const,
    title: `“${card.title}” is blocked`,
  };
  if (card.block_kind === "needs_input") {
    return {
      ...base,
      tone: "warning",
      detail: "The agent needs an answer from you.",
      action: {
        label: "Answer",
        effect: "Opens the card so you can reply.",
        intent: { kind: "open_card", taskId: card.id },
      },
    };
  }
  if (card.block_kind === "capability") {
    return {
      ...base,
      detail: "The agent can't do this with the tools it has.",
      action: {
        label: "Open card",
        effect: "Opens the card to see what it needs.",
        intent: { kind: "open_card", taskId: card.id },
      },
    };
  }
  return {
    ...base,
    detail: "It stopped on an error.",
    action: {
      label: "Retry",
      pendingLabel: "Retrying…",
      effect: "Moves the card back to Ready so a worker picks it up again.",
      intent: { kind: "unblock_card", taskId: card.id },
    },
    secondary: {
      label: "Open card",
      effect: "Opens the card.",
      intent: { kind: "open_card", taskId: card.id },
    },
  };
}

function nextCheckpoint(playbook: ProjectPlaybookResponse | null): {
  step: PlaybookStep;
  index: number;
  total: number;
} | null {
  const steps = playbook?.active?.steps ?? [];
  const index = steps.findIndex((step) => step.checkpoint === true);
  if (index < 0) return null;
  return { step: steps[index], index, total: steps.length };
}

function heroFromItem(item: NeedsYouItem, state: NextActionState): NextAction {
  return {
    key: item.key,
    state,
    tone: item.tone,
    headline: item.title,
    why: item.detail,
    primary: item.action,
    secondary: item.secondary ?? CHANGE,
    needsPerson: true,
  };
}

/**
 * The one thing the Dashboard hero asks of the person. Never `null`: when
 * somebody is needed it is the top "Needs you" item; otherwise it says the
 * agent has it (a working run) or offers the next iteration.
 *
 * Tie-break: a stalled run whose cause is the agent's own Triage cards
 * leads with the approval, because approving is what un-stalls it.
 */
export function nextAction(
  project: ProjectDetail,
  board: ProjectBoardView | null,
  readiness: ReadinessItem[],
  playbook: ProjectPlaybookResponse | null,
  now: number = nowSeconds(),
  canLead: boolean = true,
): NextAction {
  if (project.archived) {
    return {
      key: "archived",
      state: "archived",
      tone: "calm",
      headline: "This project is archived",
      why: "Restore it from the ⋯ menu to run it again.",
      primary: {
        label: "See past iterations",
        effect: "Opens the Iterations tab.",
        intent: { kind: "navigate", tab: "iterations" },
      },
      secondary: null,
      needsPerson: false,
    };
  }

  const items = needsYouItems({ project, board, readiness, playbook, canLead, now });
  const top = items[0];
  if (top) {
    if (top.key.startsWith("run:stalled:")) {
      const triage = items.find((item) => item.key === "triage");
      if (triage) {
        const runNo = top.key.split(":")[2];
        return {
          ...heroFromItem(triage, "stalled"),
          tone: "danger",
          why: `Run ${runNo} stalled: ${triage.detail.replace(/^The agent/, "it")}`,
        };
      }
      return heroFromItem(top, "stalled");
    }
    if (top.key.startsWith("run:waiting:")) return heroFromItem(top, "waiting");
    if (top.key.startsWith("run:failed:")) return heroFromItem(top, "failed");
    return heroFromItem(top, "needs_you");
  }

  const open = openRun(project);
  if (open) {
    const tasks = boardTasks(board);
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const checkpoint = nextCheckpoint(playbook);
    const parts = [
      `Run ${open.run_no} is working`,
      running > 0 ? `${plural(running, "task")} running` : null,
      tasks.length > 0 ? `${done} of ${tasks.length} cards done` : null,
    ].filter(Boolean);
    const why = checkpoint
      ? `${parts.join(" · ")}. Next for you: review at “${checkpoint.step.title}” (step ${checkpoint.index + 1} of ${checkpoint.total}).`
      : `${parts.join(" · ")}. You'll see it here when it needs you.`;
    return {
      key: `working:${open.run_no}`,
      state: "working",
      tone: "calm",
      headline: "Nothing needed from you right now",
      why,
      primary: openRunAction(open.run_no, `Watch run ${open.run_no}`),
      secondary: CHANGE,
      needsPerson: false,
    };
  }

  if (project.status === "done") {
    return {
      key: "done",
      state: "done",
      tone: "calm",
      headline: "This project is done",
      why: "Its outputs are accepted.",
      primary: {
        label: "See the outputs",
        effect: "Opens the Outputs tab.",
        intent: { kind: "navigate", tab: "outputs" },
      },
      secondary: null,
      needsPerson: false,
    };
  }

  const latest = latestRun(project);
  const workDone = latest !== null || project.card_rollup.done > 0;
  if (!workDone) {
    return {
      key: "ready",
      state: "ready",
      tone: "accent",
      headline: "Ready to start",
      why: "Everything it needs is in place.",
      primary: startRunAction(project, playbook),
      secondary: CHANGE,
      needsPerson: true,
    };
  }

  if (project.cadence === "one_off" && allOutputsAccepted(project)) {
    return {
      key: "mark_done",
      state: "idle",
      tone: "accent",
      headline: "Everything is accepted. Mark the project done?",
      why: "All required outputs have been accepted.",
      primary: {
        label: "Mark done",
        pendingLabel: "Marking done…",
        effect: "Sets the project to Done. You can reopen it later.",
        intent: { kind: "mark_done" },
      },
      secondary: startRunAction(project, playbook),
      needsPerson: true,
    };
  }

  const lastLine = latest
    ? `Run ${latest.run_no} ${latest.status === "done" ? "finished" : latest.status}. Nothing is running.`
    : "Nothing is running.";
  return {
    key: "idle",
    state: "idle",
    tone: "accent",
    headline: "Start the next iteration",
    why: lastLine,
    primary: startRunAction(project, playbook),
    secondary: CHANGE,
    needsPerson: true,
  };
}
