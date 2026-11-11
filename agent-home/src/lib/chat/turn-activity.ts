/**
 * Live "what is happening" state of one in-flight chat turn, shared by the
 * main chat pane and the lead chat panel so both surfaces render the same
 * phases (sending → thinking → tool → streaming), the same elapsed clock,
 * long-task hint, stall warning and Stop semantics.
 */
import type { ToolChip } from "@/components/chat/LiveActivity";
import type { ChatActivity } from "@/components/chat/StatusIndicator";
import type { ChatApprovalRequest } from "@/types";

export interface TurnActivity {
  reasoning: string;
  tools: ToolChip[];
  /** When the user hit send (or the page re-attached). */
  startedAt: number;
  /** Last stream event of any kind — silence beyond a threshold reads as a stall. */
  lastEventAt: number;
  /** Server confirmed it registered the turn (`run.accepted` or any later event). */
  accepted: boolean;
  /** The server's id for this turn, once known — what Stop cancels. */
  runId: string | null;
  /** The session the turn runs under, as reported by the server. */
  sessionId: string | null;
  /** The user asked to stop; the server is winding the turn down. */
  stopping: boolean;
}

/**
 * The inline confirmation shown after the user answers an approval card, so it
 * is clear what the agent is about to do (or that it was blocked).
 */
export function decisionText(choice: string, req: ChatApprovalRequest): string {
  const label = req.command || req.toolName || req.patternKey || "the tool";
  if (choice === "deny") return `Denied — the agent will not run ${label}.`;
  const scope =
    choice === "always"
      ? " (always allowed)"
      : choice === "session"
        ? " (allowed for this chat)"
        : "";
  return `Approved${scope} — running ${label}…`;
}

/** Inline note left in the thread once the server confirms a user Stop. */
export const STOPPED_NOTE =
  "Stopped — the agent was interrupted; anything it produced so far is kept.";

export function emptyActivity(runId: string | null = null): TurnActivity {
  const t = Date.now();
  return {
    reasoning: "",
    tools: [],
    startedAt: t,
    lastEventAt: t,
    accepted: runId !== null,
    runId,
    sessionId: null,
    stopping: false,
  };
}

/**
 * Which indicator phase to show for a turn. `approval` (then a `secret`
 * request) wins (the agent is blocked on the user), then a stop in progress, then the running tool, then
 * streaming text, then whether the server has acknowledged the turn yet.
 */
export function deriveActivity(input: {
  busy: boolean;
  turn: TurnActivity | null;
  approval: boolean;
  /** An FG-37 secret request is waiting on the user. */
  secret?: boolean;
  hasOutput: boolean;
}): ChatActivity {
  const { busy, turn, approval, secret, hasOutput } = input;
  if (approval) return "waiting_approval";
  if (secret) return "waiting_secret";
  if (!busy) return "idle";
  if (turn?.stopping) return "stopping";
  if (turn?.tools.some((t) => !t.done)) return "tool";
  if (hasOutput) return "streaming";
  if (turn && !turn.accepted) return "sending";
  return "thinking";
}

/** The tool currently running in a turn, if any. */
export function runningTool(turn: TurnActivity | null): ToolChip | null {
  return turn?.tools.find((t) => !t.done) ?? null;
}
