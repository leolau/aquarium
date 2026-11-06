import { boardTasks } from "@/components/projects/dashboard/derive";
import type { ProjectBoardView, ProjectDetail } from "@/types";

export type ActivityTone = "ok" | "bad" | "now" | "change" | "muted";

export interface ActivityEntry {
  key: string;
  text: string;
  tone: ActivityTone;
  /** A person or profile name when the event says who. */
  actor: string | null;
  at: number;
}

/** Noise a person never needs to read in a timeline. */
const SKIP = new Set([
  "heartbeat",
  "claim_extended",
  "claim_rejected",
  "reclaim_deferred",
  "respawn_guarded",
  "tip_scratch_workspace",
  "dependency_wait",
  "linked",
  "unlinked",
  "spawned",
]);

const SENTENCE: Record<string, { verb: (title: string) => string; tone: ActivityTone }> = {
  created: { verb: (t) => `Card ${t} was created`, tone: "change" },
  claimed: { verb: (t) => `Work started on ${t}`, tone: "now" },
  completed: { verb: (t) => `${t} finished`, tone: "ok" },
  blocked: { verb: (t) => `${t} got blocked`, tone: "bad" },
  commented: { verb: (t) => `New comment on ${t}`, tone: "change" },
  promoted: { verb: (t) => `${t} is ready for a worker`, tone: "ok" },
  promoted_manual: { verb: (t) => `${t} was approved`, tone: "ok" },
  specified: { verb: (t) => `${t} was approved`, tone: "ok" },
  edited: { verb: (t) => `${t} was edited`, tone: "change" },
  assigned: { verb: (t) => `${t} was reassigned`, tone: "change" },
  archived: { verb: (t) => `${t} was archived`, tone: "muted" },
  scheduled: { verb: (t) => `${t} was scheduled`, tone: "muted" },
  decomposed: { verb: (t) => `${t} was split into smaller cards`, tone: "change" },
  attached: { verb: (t) => `A file was attached to ${t}`, tone: "change" },
  attachment_removed: { verb: (t) => `A file was removed from ${t}`, tone: "muted" },
  timed_out: { verb: (t) => `${t} timed out`, tone: "bad" },
  gave_up: { verb: (t) => `The agent gave up on ${t}`, tone: "bad" },
  reclaimed: { verb: (t) => `${t} lost its worker and was put back`, tone: "bad" },
  stale: { verb: (t) => `${t} went quiet`, tone: "bad" },
  auto_retry: { verb: (t) => `${t} is being retried`, tone: "now" },
  block_loop_detected: { verb: (t) => `${t} keeps getting blocked`, tone: "bad" },
  block_loop_parked: { verb: (t) => `${t} was parked after repeated blocks`, tone: "bad" },
  block_loop_released: { verb: (t) => `${t} was re-run by a person`, tone: "ok" },
  replan_proposed: { verb: (t) => `A revised plan was drafted after ${t} parked`, tone: "change" },
  replan_activated: { verb: (t) => `Re-planned automatically after ${t} parked`, tone: "change" },
  replan_held: { verb: (t) => `A revised plan after ${t} parked waits for review`, tone: "bad" },
  replan_failed: { verb: (t) => `Re-planning after ${t} parked failed`, tone: "bad" },
  superseded_by_replan: { verb: (t) => `${t} was superseded by a revised plan`, tone: "muted" },
  completion_blocked_hallucination: {
    verb: (t) => `${t} was not accepted as done (references didn't check out)`,
    tone: "bad",
  },
  suspected_hallucinated_references: {
    verb: (t) => `${t} cites things that may not exist`,
    tone: "bad",
  },
};

function actorOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const key of ["author", "actor", "by"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

const RUN_END: Record<string, { word: string; tone: ActivityTone }> = {
  done: { word: "finished", tone: "ok" },
  failed: { word: "failed", tone: "bad" },
  cancelled: { word: "was closed", tone: "muted" },
  blocked: { word: "got blocked", tone: "bad" },
};

/**
 * `recent_events` (card-level kanban events) plus run starts/ends from the
 * run brief, as plain sentences, newest first.
 */
export function activityEntries(
  project: ProjectDetail,
  board: ProjectBoardView | null,
  limit = 8,
): ActivityEntry[] {
  const titles = new Map(boardTasks(board).map((task) => [task.id, task.title]));
  const out: ActivityEntry[] = [];
  for (const ev of project.recent_events) {
    if (SKIP.has(ev.kind)) continue;
    const rule = SENTENCE[ev.kind];
    const title = titles.get(ev.task_id);
    const named = title ? `“${title}”` : "a card";
    const text = rule
      ? rule.verb(named)
      : `${named[0].toUpperCase()}${named.slice(1)}: ${ev.kind.replace(/_/g, " ")}`;
    out.push({
      key: `ev:${String(ev.id)}`,
      text: text[0].toUpperCase() + text.slice(1),
      tone: rule?.tone ?? "muted",
      actor: actorOf(ev.payload),
      at: ev.created_at,
    });
  }
  for (const run of project.runs) {
    out.push({
      key: `run:${run.run_no}:start`,
      text: `Run ${run.run_no} started`,
      tone: "now",
      actor: null,
      at: run.started_at,
    });
    const end = RUN_END[run.status];
    if (end && run.ended_at != null) {
      out.push({
        key: `run:${run.run_no}:end`,
        text: `Run ${run.run_no} ${end.word}`,
        tone: end.tone,
        actor: null,
        at: run.ended_at,
      });
    }
  }
  return dedupe(out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))).slice(0, limit);
}

/** Collapse runs of the same sentence (e.g. five heartbeats-turned-edits). */
function dedupe(entries: ActivityEntry[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.text === entry.text && prev.actor === entry.actor) continue;
    out.push(entry);
  }
  return out;
}

