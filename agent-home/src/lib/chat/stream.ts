/**
 * Client-side reader for the agent-home chat stream (`POST /api/chat/stream`).
 *
 * The BFF proxies the Python `chat/stream` SSE verbatim; this parses the
 * `event:`/`data:` frames and dispatches them to typed handlers. The one event
 * that is new to agent-home is `approval.request`: a tool gated by
 * `approvals.tools` (e.g. calendar) blocks the turn and asks for approval, so
 * the caller renders an approve/deny card and resolves it via
 * `POST /api/chat/approval`. Runs in the browser (client component only).
 */
import type { ChatApprovalRequest, ChatAttachment, ChatInputMode } from "@/types";

import { formatUiContext, getUiContext } from "@/lib/app-mcp/state";
import { isInputMode } from "@/lib/chat/pending-inputs";

export interface ChatStreamHandlers {
  /** The server registered the turn (first frame, before the model runs). */
  onAccepted?(runId: string, sessionId: string): void;
  /** Incremental assistant text. */
  onDelta?(delta: string): void;
  /** Incremental model reasoning (extended thinking) text. */
  onReasoning?(text: string): void;
  /** A tool call started; `id` pairs it with its completion. */
  onToolStart?(tool: ChatToolEvent): void;
  /** A tool call finished. */
  onToolComplete?(tool: ChatToolEvent): void;
  /** A tool is blocked awaiting the user's approval decision. */
  onApproval?(req: ChatApprovalRequest): void;
  /** The turn was stopped at the user's request; completion frames follow. */
  onCancelled?(): void;
  /** The turn finished; `content` is the full assistant message. */
  onCompleted?(content: string, sessionId: string): void;
  /** A terminal, user-safe error message from the stream. */
  onError?(message: string): void;
  /** The server took a message sent while this turn runs. */
  onInputAccepted?(input: { itemId: string; mode: ChatInputMode; text: string }): void;
  /** A steer was injected after the agent's current tool step. */
  onInputSteered?(itemId: string): void;
  /** A steer the turn finished before reading; it runs as the next turn. */
  onInputDeferred?(itemId: string): void;
  /** A queued message was removed before it started. */
  onInputRemoved?(itemId: string): void;
  /**
   * The server started the next turn itself (a queued message, a leftover
   * steer, or a Stop & send). Arrives before `done`; attach to `nextRunId`.
   */
  onRunChained?(chain: ChatRunChain): void;
}

/** `run.chained`: the follow-up turn the server started on its own. */
export interface ChatRunChain {
  nextRunId: string;
  itemId: string;
  text: string;
  source: "queue" | "steer_leftover" | "interrupt";
}

/**
 * `POST /api/chat/stream` refused because a turn is already live on this
 * session (started elsewhere, or not yet seen by this page). Carries that
 * run's id so the caller can hand the message to it instead.
 */
export class TurnInProgressError extends Error {
  constructor(readonly runId: string) {
    super("A turn is already running in this conversation.");
    this.name = "TurnInProgressError";
  }
}

/** The run ended before the message reached it; send a normal turn instead. */
export class RunFinishedError extends Error {
  constructor() {
    super("The agent already finished that turn.");
    this.name = "RunFinishedError";
  }
}

const CHAIN_SOURCES: readonly ChatRunChain["source"][] = ["queue", "steer_leftover", "interrupt"];

/** A tool lifecycle event (id + name only — args/results stay server-side). */
export interface ChatToolEvent {
  id: string;
  name: string;
}

export interface ChatStreamParams {
  sessionId: string | null;
  message: string;
  attachments: ChatAttachment[];
  signal?: AbortSignal;
  /**
   * Which profile answers this turn (FG-28). The whole turn runs under that
   * profile's `HERMES_HOME` — its SOUL, config, skills, memory and
   * credentials — so omitting it here would run the default brain and file the
   * reply in the selected profile's history.
   */
  profile?: string;
}

/** One parsed SSE frame. Exported: the projects run activity stream is the
 * same wire format read by a different consumer. */
export interface StreamFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Parse one SSE block (`event:`/`data:` lines) into a frame, or null. */
function parseFrame(block: string): StreamFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Send one turn and stream the reply. Resolves to the session id the turn
 * landed on (a new conversation is created server-side when `sessionId` is
 * null). Rejects on transport failure; stream-level errors are delivered via
 * `onError`.
 */
export async function streamChatTurn(
  params: ChatStreamParams,
  handlers: ChatStreamHandlers,
): Promise<{ sessionId: string }> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId,
      message: params.message,
      attachments: params.attachments,
      profile: params.profile,
      uiContext: formatUiContext(getUiContext()) ?? undefined,
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    let detail = "The message could not be sent.";
    try {
      const body = (await res.json()) as { detail?: string; runId?: string };
      if (res.status === 409 && body.runId) throw new TurnInProgressError(body.runId);
      if (body.detail) detail = body.detail;
    } catch (err) {
      if (err instanceof TurnInProgressError) throw err;
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(detail);
  }

  const sessionId = res.headers.get("x-hermes-session-id") || params.sessionId || "";
  const { completedContent, landedSessionId } = await consumeStream(
    res,
    handlers,
    sessionId,
  );
  handlers.onCompleted?.(completedContent, landedSessionId);
  return { sessionId: landedSessionId };
}

/**
 * Re-attach to an in-flight turn after a reload: the BFF replays the turn's
 * buffered events and then tails it live, so the page resumes streaming
 * instead of waiting for the transcript to catch up.
 */
export async function attachChatStream(
  params: { sessionId: string; runId: string; signal?: AbortSignal; profile?: string },
  handlers: ChatStreamHandlers,
): Promise<void> {
  const res = await fetch("/api/chat/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId,
      runId: params.runId,
      ...(params.profile ? { profile: params.profile } : {}),
    }),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error("That run can no longer be attached.");
  }
  const { completedContent, landedSessionId } = await consumeStream(
    res,
    handlers,
    params.sessionId,
  );
  handlers.onCompleted?.(completedContent, landedSessionId);
}

/** Read SSE frames off a proxied turn stream and dispatch them. */
async function consumeStream(
  res: Response,
  handlers: ChatStreamHandlers,
  initialSessionId: string,
): Promise<{ completedContent: string; landedSessionId: string }> {
  let completedContent = "";
  let landedSessionId = initialSessionId;

  const dispatch = (frame: StreamFrame): void => {
    const { event, data } = frame;
    if (event === "run.accepted") {
      handlers.onAccepted?.(str(data.run_id) ?? "", str(data.session_id) ?? "");
    } else if (event === "assistant.delta") {
      const delta = str(data.delta);
      if (delta) handlers.onDelta?.(delta);
    } else if (event === "reasoning.delta") {
      const text = str(data.text);
      if (text) handlers.onReasoning?.(text);
    } else if (event === "tool.start") {
      handlers.onToolStart?.({
        id: str(data.tool_id) ?? "",
        name: str(data.name) ?? "tool",
      });
    } else if (event === "tool.complete") {
      handlers.onToolComplete?.({
        id: str(data.tool_id) ?? "",
        name: str(data.name) ?? "tool",
      });
    } else if (event === "approval.request") {
      handlers.onApproval?.({
        runId: str(data.run_id) ?? "",
        toolName: str(data.tool_name),
        command: str(data.command),
        description: str(data.description),
        patternKey: str(data.pattern_key),
        choices: Array.isArray(data.choices)
          ? (data.choices.filter((c) => typeof c === "string") as string[])
          : ["once", "deny"],
      });
    } else if (event === "run.cancelled") {
      handlers.onCancelled?.();
    } else if (event === "assistant.completed") {
      completedContent = str(data.content) ?? completedContent;
    } else if (event === "run.completed") {
      landedSessionId = str(data.session_id) ?? landedSessionId;
    } else if (event === "error") {
      handlers.onError?.(str(data.message) ?? "The turn failed.");
    } else if (event === "input.accepted") {
      const itemId = str(data.item_id);
      const mode = data.mode;
      if (itemId && isInputMode(mode)) {
        handlers.onInputAccepted?.({ itemId, mode, text: str(data.text) ?? "" });
      }
    } else if (event === "input.steered") {
      const itemId = str(data.item_id);
      if (itemId) handlers.onInputSteered?.(itemId);
    } else if (event === "input.deferred") {
      const itemId = str(data.item_id);
      if (itemId) handlers.onInputDeferred?.(itemId);
    } else if (event === "input.removed") {
      const itemId = str(data.item_id);
      if (itemId) handlers.onInputRemoved?.(itemId);
    } else if (event === "run.chained") {
      const nextRunId = str(data.next_run_id);
      const source = str(data.source) as ChatRunChain["source"] | undefined;
      if (nextRunId) {
        handlers.onRunChained?.({
          nextRunId,
          itemId: str(data.item_id) ?? "",
          text: str(data.text) ?? "",
          source: source && CHAIN_SOURCES.includes(source) ? source : "queue",
        });
      }
    }
  };

  await readSseFrames(res, dispatch);

  return { completedContent, landedSessionId };
}

/**
 * Stop an in-flight turn. Aborting the fetch only detaches this browser —
 * the server-side turn keeps running (by design, so a closed tab does not
 * lose work) — so Stop asks the server to interrupt the agent. The open
 * stream then receives `run.cancelled` and the normal completion frames with
 * whatever was produced so far. Rejects when the run is unknown/unreachable.
 */
export async function cancelChatTurn(params: {
  sessionId: string;
  runId: string;
  profile?: string;
}): Promise<void> {
  const res = await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId,
      runId: params.runId,
      profile: params.profile,
    }),
  });
  if (!res.ok) {
    let detail = "The agent could not be stopped.";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(detail);
  }
}

async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    return body.detail || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Send a message to a turn that is still running (`mode` says how it is
 * delivered). Resolves with the server's item id and initial status; rejects
 * with {@link RunFinishedError} when the run already ended.
 */
export async function steerChatTurn(params: {
  sessionId: string;
  runId: string;
  text: string;
  mode: ChatInputMode;
  profile?: string;
}): Promise<{ itemId: string; mode: ChatInputMode; status: "pending" | "queued" }> {
  const res = await fetch("/api/chat/steer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId,
      runId: params.runId,
      text: params.text,
      mode: params.mode,
      profile: params.profile,
    }),
  });
  if (!res.ok) {
    const detail = await errorDetail(res, "The message could not be sent.");
    if (res.status === 409 && detail === "run_finished") throw new RunFinishedError();
    throw new Error(detail);
  }
  const body = (await res.json()) as {
    item_id?: string;
    mode?: ChatInputMode;
    status?: "pending" | "queued";
  };
  return {
    itemId: body.item_id ?? "",
    mode: body.mode ?? params.mode,
    status: body.status ?? (params.mode === "steer" ? "pending" : "queued"),
  };
}

/** Remove a queued message before it starts; resolves whether it was removed. */
export async function removeQueuedInput(params: {
  sessionId: string;
  runId: string;
  itemId: string;
  profile?: string;
}): Promise<boolean> {
  const res = await fetch("/api/chat/queue/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId,
      runId: params.runId,
      itemId: params.itemId,
      profile: params.profile,
    }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, "That message could not be removed."));
  const body = (await res.json()) as { removed?: boolean };
  return Boolean(body.removed);
}

/**
 * Read an SSE response frame by frame until the stream ends. Shared by the
 * chat turn reader and the projects run activity reader — one parser, so a
 * keepalive comment or a split frame is handled the same way on both.
 */
export async function readSseFrames(
  res: Response,
  onFrame: (frame: StreamFrame) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (block.trim() && !block.startsWith(":")) {
        const frame = parseFrame(block);
        if (frame) onFrame(frame);
      }
      sep = buffer.indexOf("\n\n");
    }
  }
}
