"use client";

import { useEffect, useRef, useState } from "react";

import type { ChatActivity } from "@/components/chat/StatusIndicator";
import { useFollowLatest } from "@/components/chat/useFollowLatest";
import { markSessionRead } from "@/lib/chat/last-read";
import {
  insertSteeredBubble,
  setLastAssistantContent,
  withLiveTurn,
  type LiveTurn,
} from "@/lib/chat/messages";
import {
  dropPending,
  initialStatus,
  DELIVERED_MS,
  markDeferred,
  markDelivered,
  notSentNotice,
  pendingFromActive,
  upsertPending,
} from "@/lib/chat/pending-inputs";
import { withProfileQuery } from "@/lib/chat/profile";
import {
  attachChatStream,
  cancelChatTurn,
  removeQueuedInput,
  RunFinishedError,
  steerChatTurn,
  streamChatTurn,
  TurnInProgressError,
  type ChatRunChain,
  type ChatStreamHandlers,
} from "@/lib/chat/stream";
import {
  decisionText,
  deriveActivity,
  emptyActivity,
  runningTool,
  STOPPED_NOTE,
  type TurnActivity,
} from "@/lib/chat/turn-activity";
import { notifySessionsChanged } from "@/lib/chat/sessions-changed";
import { visibleTurns } from "@/lib/chat/transcript";
import { mayGetAutoTitle, waitForAutoTitle } from "@/lib/landing/titles";
import { useAction } from "@/lib/use-action";
import type {
  ChatApprovalRequest,
  ChatSecretRequest,
  ChatAttachment,
  ChatInputMode,
  ChatMessage,
  ChatSendResult,
  PendingChatInput,
  SessionSummary,
} from "@/types";

/** Map key for a not-yet-created ("New conversation") session. */
export const NEW_KEY = "__new__";
export const keyOf = (id: string | null): string => id ?? NEW_KEY;

/** Idle-watch cadence for turns started on other surfaces. */
const ACTIVE_WATCH_MS = 10_000;

/** Only user/assistant turns are shown in the visible thread. */
function dropTrailingEmptyAssistant(prev: ChatMessage[]): ChatMessage[] {
  const last = prev[prev.length - 1];
  return last && last.role === "assistant" && last.content === ""
    ? prev.slice(0, -1)
    : prev;
}

/** True while the latest assistant turn has streamed no text yet. */
export function assistantIsEmpty(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !last || last.role !== "assistant" || last.content === "";
}

function dropKey<T>(rec: Record<string, T>, k: string): Record<string, T> {
  if (!(k in rec)) return rec;
  const next = { ...rec };
  delete next[k];
  return next;
}

export interface ChatConversationOptions {
  /** The session's profile (FG-28): every read and turn is addressed to it. */
  profile: string;
  initialSessionId: string | null;
  initialMessages: ChatMessage[];
  /** Words to highlight on arrival (a message-search hit). */
  initialHighlight?: string;
  /** Fetch the transcript on mount instead of using `initialMessages`. */
  loadOnMount?: boolean;
  /** Text for an auto-sent first turn (the landing composer's hand-off). */
  initialDraft?: string;
  /** Send `initialDraft` once on arrival. */
  autoSend?: boolean;
  /** Looks up a conversation in the caller's list (auto-title check). */
  findSession: (id: string) => SessionSummary | undefined;
  /** A turn ended or a title may have landed: re-read the conversation list. */
  onSessionsStale: () => void;
}

/**
 * One open conversation: its transcript, per-session live turns (send,
 * stream, stop, re-attach), approvals and the search highlight. Shared by
 * the chat page ({@link ChatPane}) and the landing page's inline chat.
 */
export function useChatConversation({
  profile,
  initialSessionId,
  initialMessages,
  initialHighlight,
  loadOnMount = false,
  initialDraft,
  autoSend = false,
  findSession,
  onSessionsStale,
}: ChatConversationOptions) {
  const path = (p: string) => withProfileQuery(p, profile);
  const sessionsStale = () => {
    onSessionsStale();
    notifySessionsChanged({ profile });
  };
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(visibleTurns(initialMessages));
  const [loadingThread, setLoadingThread] = useState(loadOnMount && initialSessionId !== null);
  // Per-session state, keyed by session id (or NEW_KEY). Turns run per session
  // so the user can switch conversations at any time without cancelling or
  // cross-contaminating an in-flight turn.
  const [sendingKeys, setSendingKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Record<string, ChatApprovalRequest>>({});
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [liveActivity, setLiveActivity] = useState<Record<string, TurnActivity>>({});
  // Wall clock, ticked once a second only while a turn is in flight, so the
  // elapsed counter / long-task hint / stall warning advance without a timer
  // per turn.
  const [now, setNow] = useState(() => Date.now());
  const [resolvingApproval, setResolvingApproval] = useState(false);
  /** FG-37: the secret request each paused turn is waiting on, by turn key. */
  const [secretRequests, setSecretRequests] = useState<Record<string, ChatSecretRequest>>({});
  const threadRef = useRef<HTMLDivElement | null>(null);
  const followRef = useFollowLatest(threadRef);
  // Mirrors the selected session for use inside async stream callbacks, and
  // buffers turns whose session is not currently on screen.
  const selectedRef = useRef<string | null>(sessionId);
  const liveRef = useRef<Map<string, LiveTurn>>(new Map());
  // One AbortController per in-flight turn (keyed like the buffers) so the user
  // can stop the turn for the conversation currently on screen.
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  // Messages sent while a turn runs that the agent has not read yet (the
  // composer's chips), per session. The ref is read inside stream callbacks;
  // the state mirrors it for rendering.
  const [pendingInputs, setPendingInputs] = useState<Record<string, PendingChatInput[]>>({});
  const pendingRef = useRef<Map<string, PendingChatInput[]>>(new Map());
  /** Queued items the user is taking back (their `input.removed` is expected). */
  const removingRef = useRef(new Set<string>());
  // Synchronous mirror of `sendingKeys` for code that runs after an await.
  const busyRef = useRef<Set<string>>(new Set());
  // `run.chained` seen on a turn's stream: the follow-up run to attach to
  // once this one's stream ends.
  const chainRef = useRef<Map<string, ChatRunChain>>(new Map());

  // ── Search highlight ──
  const [inSearchOpen, setInSearchOpen] = useState(initialHighlight !== undefined);
  const [highlightTerm, setHighlightTerm] = useState<string | undefined>(initialHighlight);
  const highlightCallbackRef = useRef<((msgIndex: number, term: string) => void) | null>(null);

  // Wire the InSessionSearch callback so it sets the highlight term.
  useEffect(() => {
    highlightCallbackRef.current = (_msgIndex: number, term: string) => {
      setHighlightTerm(term || undefined);
    };
  }, []);

  useEffect(() => {
    selectedRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (sendingKeys.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sendingKeys.length]);

  const selKey = keyOf(sessionId);
  const watchBusy = sendingKeys.includes(selKey);
  const selBusy = sendingKeys.includes(selKey);
  const selApproval = approvals[selKey] ?? null;
  const selSecretRequest = secretRequests[selKey] ?? null;
  const selDecision = decisions[selKey] ?? null;
  const selTurn = selBusy ? (liveActivity[selKey] ?? null) : null;
  const selRunningTool = runningTool(selTurn);
  const selPending = selBusy ? (pendingInputs[selKey] ?? []) : [];
  const selActivity: ChatActivity = deriveActivity({
    busy: selBusy,
    turn: selTurn,
    approval: selApproval !== null,
    secret: selSecretRequest !== null,
    hasOutput: !assistantIsEmpty(messages),
  });

  // Keep the thread pinned to the bottom as content grows (streamed text, the
  // status indicator, an approval card, or the decision note) while the reader
  // is following it; a reader who scrolled up to read older messages stays put.
  // A double rAF lets late-laid-out nodes (the approval card renders below the
  // scroll box) settle before we measure, so the newest content is in view.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    const pin = () => {
      const el = threadRef.current;
      if (el && followRef.current) el.scrollTop = el.scrollHeight;
    };
    raf1 = requestAnimationFrame(() => {
      pin();
      raf2 = requestAnimationFrame(pin);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [
    messages,
    sendingKeys,
    selApproval,
    selSecretRequest,
    selDecision,
    loadingThread,
    liveActivity,
    followRef,
  ]);

  const addSending = (k: string) => {
    busyRef.current.add(k);
    setSendingKeys((prev) => (prev.includes(k) ? prev : [...prev, k]));
  };
  const removeSending = (k: string) => {
    busyRef.current.delete(k);
    setSendingKeys((prev) => prev.filter((x) => x !== k));
  };

  /** Say which messages sent while working never reached the agent. */
  function flagNotSent(items: PendingChatInput[]) {
    const notice = notSentNotice(items);
    if (notice) setError(notice);
  }

  /** A turn is over: any chip still showing was neither read nor run. */
  function clearPending(turnKey: string) {
    const left = pendingRef.current.get(turnKey) ?? [];
    updatePending(turnKey, () => []);
    flagNotSent(left);
  }

  function updatePending(
    turnKey: string,
    update: (cur: PendingChatInput[]) => PendingChatInput[],
  ) {
    const next = update(pendingRef.current.get(turnKey) ?? []);
    if (next.length > 0) pendingRef.current.set(turnKey, next);
    else pendingRef.current.delete(turnKey);
    setPendingInputs((prev) =>
      next.length > 0 ? { ...prev, [turnKey]: next } : dropKey(prev, turnKey),
    );
  }

  async function openConversation(id: string) {
    // Switching is allowed at any time — a turn in another session keeps
    // streaming into its own buffer and is overlaid when you return to it.
    if (id === sessionId) return;
    await loadConversation(id);
  }

  async function loadConversation(id: string) {
    followRef.current = true;
    setSessionId(id);
    selectedRef.current = id;
    setError(null);
    setLoadingThread(true);
    // Show any buffered live turn for this session immediately.
    setMessages(withLiveTurn([], liveRef.current.get(keyOf(id))));
    try {
      const res = await fetch(
        path(`/api/chat/messages?sessionId=${encodeURIComponent(id)}`),
        { cache: "no-store" },
      );
      const body = (await res.json()) as {
        messages?: ChatMessage[];
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail ?? "Failed to load conversation.");
      // Re-read the buffer (it may have grown while the transcript loaded) and
      // overlay it onto the persisted history.
      if (selectedRef.current === id) {
        setMessages(
          withLiveTurn(visibleTurns(body.messages ?? []), liveRef.current.get(keyOf(id))),
        );
        markSessionRead(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversation.");
    } finally {
      setLoadingThread(false);
    }
  }

  /**
   * Quiet in-place transcript re-read for the session currently on screen —
   * no loading state, no session switching. Used after the idle watcher
   * attaches to an externally-started turn so the persisted rows replace the
   * live overlay, and as the fallthrough when the turn finished before we
   * could attach.
   */
  async function reloadTranscript(id: string) {
    try {
      const res = await fetch(
        path(`/api/chat/messages?sessionId=${encodeURIComponent(id)}`),
        { cache: "no-store" },
      );
      const body = (await res.json()) as { messages?: ChatMessage[] };
      if (!res.ok) return;
      if (selectedRef.current === id) {
        setMessages(
          withLiveTurn(visibleTurns(body.messages ?? []), liveRef.current.get(keyOf(id))),
        );
        markSessionRead(id);
      }
    } catch {
      // A stale transcript is non-fatal — the next change retries.
    }
  }

  function startNewConversation() {
    followRef.current = true;
    setSessionId(null);
    selectedRef.current = null;
    setMessages(withLiveTurn([], liveRef.current.get(NEW_KEY)));
    setError(null);
  }

  /** Start (or reset) the activity record for a turn, stamping its clock. */
  function beginActivity(turnKey: string, runId: string | null = null) {
    setLiveActivity((prev) => ({ ...prev, [turnKey]: emptyActivity(runId) }));
  }

  /** Tell every chats list the moment the turn lands, so a new chat shows at once. */
  function withSessionNotice(handlers: ChatStreamHandlers, text: string): ChatStreamHandlers {
    return {
      ...handlers,
      onAccepted: (runId, sid) => {
        handlers.onAccepted?.(runId, sid);
        if (sid) notifySessionsChanged({ profile, session: { id: sid, preview: text } });
      },
    };
  }

  function makeTurnHandlers(
    turnKey: string,
    setLive: (content: string) => void,
  ): ChatStreamHandlers {
    // Every stream event bumps lastEventAt so the stall detector only fires
    // on genuine silence, not on a long but visibly active step.
    const touch = (
      update: (cur: TurnActivity) => Partial<TurnActivity>,
    ) =>
      setLiveActivity((prev) => {
        const cur = prev[turnKey] ?? emptyActivity();
        return {
          ...prev,
          [turnKey]: { ...cur, ...update(cur), lastEventAt: Date.now() },
        };
      });
    return {
      onAccepted: (runId, sid) =>
        touch(() => ({ accepted: true, runId, sessionId: sid })),
      onCancelled: () => {
        touch(() => ({ stopping: true }));
        setDecisions((prev) => ({ ...prev, [turnKey]: STOPPED_NOTE }));
      },
      onDelta: (delta) => {
        const buf = liveRef.current.get(turnKey);
        setLive((buf?.assistant ?? "") + delta);
        touch(() => ({ accepted: true }));
      },
      onReasoning: (text) =>
        touch((cur) => ({ reasoning: cur.reasoning + text, accepted: true })),
      onToolStart: (tool) =>
        touch((cur) => ({
          tools: [...cur.tools, { ...tool, done: false }],
          accepted: true,
        })),
      onToolComplete: (tool) =>
        touch((cur) => ({
          tools: cur.tools.map((c) => (c.id === tool.id ? { ...c, done: true } : c)),
        })),
      onApproval: (req) => {
        setApprovals((prev) => ({ ...prev, [turnKey]: req }));
        touch(() => ({}));
      },
      onSecretRequest: (req) => {
        setSecretRequests((prev) => ({ ...prev, [turnKey]: req }));
        touch(() => ({}));
      },
      onCompleted: (content) => {
        setApprovals((prev) => dropKey(prev, turnKey));
        setSecretRequests((prev) => dropKey(prev, turnKey));
        if (content) setLive(content);
      },
      onError: (message) => setError(message),
      onInputAccepted: (input) =>
        updatePending(turnKey, (cur) =>
          upsertPending(cur, { ...input, status: initialStatus(input.mode) }),
        ),
      onInputSteered: (itemId) => {
        const item = pendingRef.current.get(turnKey)?.find((p) => p.itemId === itemId);
        // The chip says "Delivered" for a moment; the bubble carries the label.
        updatePending(turnKey, (cur) => markDelivered(cur, itemId));
        window.setTimeout(
          () => updatePending(turnKey, (cur) => dropPending(cur, itemId)),
          DELIVERED_MS,
        );
        if (!item) return;
        const buf = liveRef.current.get(turnKey);
        if (buf) buf.steered = [...(buf.steered ?? []), item.text];
        if (keyOf(selectedRef.current) === turnKey) {
          setMessages((prev) => insertSteeredBubble(prev, item.text));
        }
        touch(() => ({}));
      },
      onInputDeferred: (itemId) => updatePending(turnKey, (cur) => markDeferred(cur, itemId)),
      onInputRemoved: (itemId) => {
        const item = (pendingRef.current.get(turnKey) ?? []).find((p) => p.itemId === itemId);
        updatePending(turnKey, (cur) => dropPending(cur, itemId));
        // The user's own ✕ needs no notice; anything else never reached the agent.
        if (removingRef.current.delete(itemId) || !item) return;
        flagNotSent([item]);
      },
      onRunChained: (chain) => {
        chainRef.current.set(turnKey, chain);
      },
    };
  }

  /**
   * The server starts the next turn itself when a run ends with a queued
   * message, a leftover steer or a Stop & send (`run.chained`). Attach to it
   * — and to whatever it chains to — so the composer stays busy and the
   * follow-up streams in like any other turn. `fromKey` is the key the
   * finished stream ran under; a first turn of a new chat moves to its
   * landed session's key here.
   */
  async function followChain(fromKey: string, sid: string) {
    const turnKey = keyOf(sid);
    let chain = chainRef.current.get(fromKey);
    if (!chain) {
      clearPending(fromKey);
      return;
    }
    chainRef.current.delete(fromKey);
    if (turnKey !== fromKey) {
      const carried = pendingRef.current.get(fromKey) ?? [];
      updatePending(fromKey, () => []);
      updatePending(turnKey, () => carried);
      addSending(turnKey);
    }
    try {
      while (chain) {
        const next = chain;
        updatePending(turnKey, (cur) =>
          cur.filter((p) => p.itemId !== next.itemId && !next.itemIds.includes(p.itemId)),
        );
        setApprovals((prev) => dropKey(prev, turnKey));
        setSecretRequests((prev) => dropKey(prev, turnKey));
        setDecisions((prev) => dropKey(prev, turnKey));
        liveRef.current.set(turnKey, { user: next.text, assistant: "" });
        setLiveActivity((prev) => ({
          ...prev,
          [turnKey]: { ...emptyActivity(next.nextRunId), sessionId: sid },
        }));
        const onScreen = () => selectedRef.current === sid;
        if (onScreen()) {
          setMessages((prev) => [
            ...dropTrailingEmptyAssistant(prev),
            { role: "user", content: next.text },
            { role: "assistant", content: "" },
          ]);
        }
        const setLive = (content: string) => {
          const buf = liveRef.current.get(turnKey);
          if (buf) buf.assistant = content;
          if (onScreen()) setMessages((prev) => setLastAssistantContent(prev, content));
        };
        try {
          await attachChatStream(
            { sessionId: sid, runId: next.nextRunId, profile },
            makeTurnHandlers(turnKey, setLive),
          );
        } catch {
          // Gone before we could attach — the transcript reload shows it.
          break;
        } finally {
          if (onScreen()) setMessages(dropTrailingEmptyAssistant);
        }
        chain = chainRef.current.get(turnKey);
        chainRef.current.delete(turnKey);
      }
      sessionsStale();
    } finally {
      chainRef.current.delete(turnKey);
      clearPending(turnKey);
      if (turnKey !== fromKey) {
        removeSending(turnKey);
        liveRef.current.delete(turnKey);
        setApprovals((prev) => dropKey(prev, turnKey));
        setSecretRequests((prev) => dropKey(prev, turnKey));
        setLiveActivity((prev) => dropKey(prev, turnKey));
      }
    }
  }

  /**
   * Reload mid-turn: the server-side turn outlives the page, so re-attach to
   * its stream and keep the content flowing. The transcript already ends at
   * the user message; a trailing assistant bubble is added only in that case.
   */
  async function resumeTurn(sid: string, runId: string) {
    const turnKey = keyOf(sid);
    if (busyRef.current.has(turnKey)) return; // already attached/attaching
    setError(null);
    addSending(turnKey);
    liveRef.current.set(turnKey, { user: "", assistant: "" });
    beginActivity(turnKey, runId);
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      return last && last.role === "user"
        ? [...prev, { role: "assistant", content: "" }]
        : prev;
    });
    const setLive = (content: string) => {
      const buf = liveRef.current.get(turnKey);
      if (buf) buf.assistant = content;
      if (selectedRef.current === sid) {
        setMessages((prev) => setLastAssistantContent(prev, content));
      }
    };
    try {
      await attachChatStream(
        { sessionId: sid, runId },
        makeTurnHandlers(turnKey, setLive),
      );
      if (selectedRef.current === sid) setMessages(dropTrailingEmptyAssistant);
      await followChain(turnKey, sid);
      sessionsStale();
    } catch {
      // The grace window may have passed; the next transcript load shows the
      // finished turn.
    } finally {
      removeSending(turnKey);
      liveRef.current.delete(turnKey);
      chainRef.current.delete(turnKey);
      clearPending(turnKey);
      setApprovals((prev) => dropKey(prev, turnKey));
      setSecretRequests((prev) => dropKey(prev, turnKey));
      setLiveActivity((prev) => dropKey(prev, turnKey));
    }
  }

  /**
   * A message sent while a turn runs on this session: steer it into the
   * running turn, queue it for the next one, or stop and send it (`mode`).
   * The chip shows until the agent reads it. When the run finished in the
   * meantime the message goes out as a normal turn instead.
   */
  async function sendWhileWorking(text: string, mode: ChatInputMode): Promise<ChatSendResult> {
    const turnKey = selKey;
    const turn = liveActivity[turnKey];
    const runId = turn?.runId ?? null;
    const sid = turn?.sessionId || sessionId;
    if (!runId || !sid) {
      setError("The agent is still starting — send that again in a moment.");
      return false;
    }
    setError(null);
    try {
      const item = await steerChatTurn({ sessionId: sid, runId, text, mode, profile });
      // The stream may already have reported (or even delivered) the item.
      if (item.itemId && busyRef.current.has(turnKey)) {
        updatePending(turnKey, (cur) =>
          upsertPending(cur, { itemId: item.itemId, mode: item.mode, text, status: item.status }),
        );
      }
      return true;
    } catch (err) {
      if (err instanceof RunFinishedError) return startTurn(text, [], { afterRunEnds: true });
      setError(err instanceof Error ? err.message : "The message could not be sent.");
      return false;
    }
  }

  /** Take a queued message back before it starts. */
  async function removePending(itemId: string) {
    const turnKey = selKey;
    const turn = liveActivity[turnKey];
    const runId = turn?.runId ?? null;
    const sid = turn?.sessionId || sessionId;
    if (!runId || !sid) return;
    removingRef.current.add(itemId);
    try {
      const removed = await removeQueuedInput({ sessionId: sid, runId, itemId, profile });
      // Not removed means it already started; its own turn replaces the chip.
      if (removed) updatePending(turnKey, (cur) => dropPending(cur, itemId));
      else removingRef.current.delete(itemId);
    } catch (err) {
      removingRef.current.delete(itemId);
      setError(err instanceof Error ? err.message : "That message could not be removed.");
    }
  }

  /**
   * Send from the composer. While this session's turn runs, the message is
   * delivered to that turn by `mode` (Steer by default); otherwise it starts
   * a turn.
   */
  async function send(
    text: string,
    attachments: ChatAttachment[],
    mode?: ChatInputMode,
  ): Promise<ChatSendResult> {
    if (busyRef.current.has(selKey)) return sendWhileWorking(text, mode ?? "steer");
    return startTurn(text, attachments);
  }

  /**
   * Send one turn. Returns false only when the message never reached the
   * agent (transport failure) — the composer restores the draft on that
   * signal. A user-initiated stop resolves true: the streamed partial stays,
   * and restoring the draft would read as an error that wasn't.
   */
  async function startTurn(
    text: string,
    attachments: ChatAttachment[],
    { afterRunEnds = false }: { afterRunEnds?: boolean } = {},
  ): Promise<ChatSendResult> {
    // The session this turn belongs to, captured up-front so late-arriving
    // events are attributed to their origin, not to whatever is selected later.
    const turnSessionId = sessionId;
    const turnKey = keyOf(turnSessionId);
    if (busyRef.current.has(turnKey)) {
      // A steer that found its run finished: that run's stream is closing
      // here too; wait for it to wind down before starting the next turn.
      if (!afterRunEnds) return false;
      await waitUntilIdle(turnKey);
      if (busyRef.current.has(turnKey)) return false;
    }
    setError(null);
    setApprovals((prev) => dropKey(prev, turnKey));
    setSecretRequests((prev) => dropKey(prev, turnKey));
    setDecisions((prev) => dropKey(prev, turnKey));
    followRef.current = true;
    addSending(turnKey);
    // Buffer this turn so it survives session switches; the buffer's assistant
    // text is the single source of truth for accumulated deltas.
    liveRef.current.set(turnKey, { user: text, assistant: "" });
    beginActivity(turnKey);
    const controller = new AbortController();
    abortRef.current.set(turnKey, controller);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);

    const onThisSession = () => selectedRef.current === turnSessionId;
    // Update the trailing assistant bubble by position (identity-safe), but
    // only when this turn's session is the one on screen — otherwise just grow
    // the buffer so we never write into another session's thread.
    const setLive = (content: string) => {
      const buf = liveRef.current.get(turnKey);
      if (buf) buf.assistant = content;
      if (onThisSession()) {
        setMessages((prev) => setLastAssistantContent(prev, content));
      }
    };

    let busyRunId: string | null = null;
    try {
      const { sessionId: landed } = await streamChatTurn(
        {
          sessionId: turnSessionId,
          message: text,
          attachments,
          signal: controller.signal,
          profile,
        },
        withSessionNotice(makeTurnHandlers(turnKey, setLive), text),
      );
      // A brand-new session lands an id only at completion; you cannot have
      // navigated to it mid-stream, so adopt it only if still on this turn.
      if (landed && landed !== turnSessionId && onThisSession()) {
        setSessionId(landed);
        selectedRef.current = landed;
      }
      if (landed && onThisSession()) markSessionRead(landed);
      // A turn stopped before its first token completes with no text; never
      // leave a blank reply bubble behind.
      if (onThisSession()) setMessages(dropTrailingEmptyAssistant);
      const landedSid = landed || turnSessionId;
      if (landedSid) await followChain(turnKey, landedSid);
      sessionsStale();
      // The backend auto-titles a new chat a few seconds after its first reply.
      const titledId = landed || turnSessionId;
      if (titledId && mayGetAutoTitle(findSession(titledId))) {
        void waitForAutoTitle(titledId, { profile }).then((t) => {
          if (t) sessionsStale();
        });
      }
      return true;
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (err instanceof TurnInProgressError && turnSessionId) {
        // Another tab or device is already running a turn here: follow it
        // and hand this message to it as a steer (below, once this turn's
        // state is cleared) instead of failing.
        if (onThisSession()) {
          setMessages((prev) => prev.slice(0, Math.max(0, prev.length - 2)));
        }
        busyRunId = err.runId;
      } else if (aborted) {
        // The user stopped the turn. Keep whatever streamed so far; only drop a
        // trailing empty assistant bubble so we never leave a blank reply.
        if (onThisSession()) setMessages(dropTrailingEmptyAssistant);
      } else {
        if (onThisSession()) {
          setMessages((prev) => prev.slice(0, Math.max(0, prev.length - 2)));
        }
        setError(err instanceof Error ? err.message : "The message could not be sent.");
      }
      if (!busyRunId) return aborted;
    } finally {
      // Turn is done and now persisted server-side; drop the live buffer so a
      // later re-open shows the canonical transcript, not a duplicate overlay.
      removeSending(turnKey);
      liveRef.current.delete(turnKey);
      abortRef.current.delete(turnKey);
      chainRef.current.delete(turnKey);
      clearPending(turnKey);
      setApprovals((prev) => dropKey(prev, turnKey));
      setSecretRequests((prev) => dropKey(prev, turnKey));
      setLiveActivity((prev) => dropKey(prev, turnKey));
    }
    const joinRunId: string | null = busyRunId;
    if (!joinRunId || !turnSessionId) return false;
    // The running turn takes the text only; the files go back to the composer.
    const joined = await joinRunningTurn(turnSessionId, joinRunId, text);
    return joined && attachments.length > 0 ? "attachments_kept" : joined;
  }

  /** Resolves once `turnKey` has no live turn (polls the busy mirror). */
  function waitUntilIdle(turnKey: string, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!busyRef.current.has(turnKey) || Date.now() - started > timeoutMs) resolve();
        else window.setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** `turn_in_progress`: attach to the run already going and steer this message into it. */
  async function joinRunningTurn(sid: string, runId: string, text: string): Promise<boolean> {
    const turnKey = keyOf(sid);
    void resumeTurn(sid, runId);
    setLiveActivity((prev) => ({
      ...prev,
      [turnKey]: { ...(prev[turnKey] ?? emptyActivity(runId)), runId, sessionId: sid },
    }));
    try {
      const item = await steerChatTurn({ sessionId: sid, runId, text, mode: "steer", profile });
      if (item.itemId && busyRef.current.has(turnKey)) {
        updatePending(turnKey, (cur) =>
          upsertPending(cur, { itemId: item.itemId, mode: item.mode, text, status: item.status }),
        );
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The message could not be sent.");
      return false;
    }
  }

  // Deep-linked open (notification tap / ?session=…): the transcript is
  // rendered server-side, so mark it read once on mount for the unread badge.
  // An inline open fetches it first and marks it read once it has loaded.
  useEffect(() => {
    if (!initialSessionId) return;
    if (loadOnMount) void loadConversation(initialSessionId);
    else markSessionRead(initialSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle watch: a turn can start on the open conversation from another
  // surface (Telegram, another device, a scheduled job) or be mid-flight when
  // the page loads. While no local turn is running, poll `active` on a short
  // cadence and on wake; when a run appears, attach to its stream so the
  // reply arrives live instead of on the next manual reload. Also covers the
  // mount-time "re-attach to the in-flight turn" case the old one-shot
  // effect handled.
  useEffect(() => {
    if (!sessionId || watchBusy) return;
    let cancelled = false;
    let attaching = false;
    const check = async () => {
      if (cancelled || attaching || document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetch(
          path(`/api/chat/active?sessionId=${encodeURIComponent(sessionId)}`),
          { cache: "no-store" },
        );
        const data = (await res.json()) as { runId?: string | null; pending?: unknown };
        if (cancelled || !res.ok || !data.runId) return;
        attaching = true;
        // Redraw the chips for messages sent before the reload.
        const restored = pendingFromActive(data.pending);
        if (restored.length > 0) updatePending(keyOf(sessionId), () => restored);
        await resumeTurn(sessionId, data.runId);
        // Reconcile against the persisted transcript whether the attach
        // succeeded or the turn had already finished.
        if (!cancelled && selectedRef.current === sessionId) {
          void reloadTranscript(sessionId);
        }
      } catch {
        // A failed probe is non-fatal — the next tick retries.
      } finally {
        attaching = false;
      }
    };
    void check();
    const interval = window.setInterval(check, ACTIVE_WATCH_MS);
    const onWake = () => void check();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, profile, watchBusy]);

  const autoSentRef = useRef(false);
  useEffect(() => {
    if (!autoSend || autoSentRef.current || !initialDraft) return;
    autoSentRef.current = true;
    // Drop the hand-off from the address bar first, so a reload or Back
    // re-opens this chat instead of sending the same first turn again.
    const url = new URL(window.location.href);
    for (const key of ["new", "autosend", "draft"]) url.searchParams.delete(key);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    void send(initialDraft, []);
    // Once, on arrival: the landing page handed over a turn the user already sent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolveApproval(choice: string) {
    const req = selApproval;
    if (!req || resolvingApproval) return;
    const targetKey = selKey;
    setResolvingApproval(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: req.runId, choice }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? "Your decision could not be submitted.");
      }
      // The turn resumes on the open stream. Clear the card and leave an inline
      // note so it is clear what the agent will now do (or that it was denied).
      setApprovals((prev) => dropKey(prev, targetKey));
      setDecisions((prev) => ({ ...prev, [targetKey]: decisionText(choice, req) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your decision could not be submitted.");
    } finally {
      setResolvingApproval(false);
    }
  }

  /** The secret popup answered (or declined) the request: clear it, leave a note. */
  function resolveSecretRequest(note: string) {
    const targetKey = selKey;
    setSecretRequests((prev) => dropKey(prev, targetKey));
    setDecisions((prev) => ({ ...prev, [targetKey]: note }));
  }

  // Approve and Deny share one lock: a second press before the first answer
  // lands is dropped, so the server never gets two decisions for one request.
  const { run: resolveApprovalOnce } = useAction(resolveApproval);

  // Stop the in-flight turn for the conversation currently on screen. Closing
  // the connection alone would NOT stop the server-side turn (it survives a
  // closed tab by design), so ask the server to interrupt the agent and keep
  // the stream open to receive the partial reply. Before the server has
  // acknowledged the turn there is no run to cancel; aborting the request is
  // the only option then.
  async function stopTurn() {
    const targetKey = selKey;
    const turn = liveActivity[targetKey];
    const runId = turn?.runId ?? null;
    const sid = turn?.sessionId ?? sessionId;
    if (!runId || !sid || turn?.stopping) {
      abortRef.current.get(targetKey)?.abort();
      return;
    }
    setLiveActivity((prev) => {
      const cur = prev[targetKey];
      return cur ? { ...prev, [targetKey]: { ...cur, stopping: true } } : prev;
    });
    try {
      await cancelChatTurn({ sessionId: sid, runId, profile });
    } catch (err) {
      abortRef.current.get(targetKey)?.abort();
      setError(err instanceof Error ? err.message : "The agent could not be stopped.");
    }
  }

  return {
    sessionId,
    messages,
    loadingThread,
    error,
    now,
    liveActivity,
    selKey,
    selBusy,
    selApproval,
    selSecretRequest,
    selDecision,
    selTurn,
    selRunningTool,
    selActivity,
    resolvingApproval,
    threadRef,
    inSearchOpen,
    setInSearchOpen,
    highlightTerm,
    setHighlightTerm,
    highlightCallbackRef,
    openConversation,
    startNewConversation,
    send,
    stopTurn,
    selPending,
    removePending,
    resolveApproval: resolveApprovalOnce,
    resolveSecretRequest,
    profile,
  };
}

export type ChatConversation = ReturnType<typeof useChatConversation>;
