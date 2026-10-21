"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useAction } from "@/lib/use-action";

import { useRouter } from "next/navigation";

import { ApprovalModal } from "@/components/chat/ApprovalModal";
import { ArchivedModal } from "@/components/chat/ArchivedModal";
import { InSessionSearch } from "@/components/chat/InSessionSearch";
import { LiveActivity } from "@/components/chat/LiveActivity";
import { DEFAULT_PROFILE, ProfilePicker } from "@/components/chat/ProfilePicker";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { Composer } from "@/components/chat/Composer";
import { SessionModal } from "@/components/chat/SessionModal";
import { SessionSearchBar } from "@/components/chat/SessionSearchBar";
import { SessionTabs } from "@/components/chat/SessionTabs";
import {
  StatusIndicator,
  type ChatActivity,
} from "@/components/chat/StatusIndicator";
import { TagFilterBar } from "@/components/chat/TagFilterBar";
import { useFollowLatest } from "@/components/chat/useFollowLatest";
import {
  categorizeSession,
  categoryOverrideTagName,
  isCategoryOverrideTag,
  type ChatCategory,
} from "@/lib/chat/categorize";
import { chatHeaderActionsRef } from "@/lib/chat/header-actions";
import { markSessionRead } from "@/lib/chat/last-read";
import {
  setLastAssistantContent,
  withLiveTurn,
  type LiveTurn,
} from "@/lib/chat/messages";
import {
  nextActiveAfterArchive,
  orderSessions,
  parseOrder,
  SESSION_ORDER_STORAGE_KEY,
} from "@/lib/chat/session-order";
import { withProfileBody, withProfileQuery } from "@/lib/chat/profile";
import { fetchSessionList } from "@/lib/chat/session-list-fetch";
import {
  attachChatStream,
  cancelChatTurn,
  streamChatTurn,
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
import { usePersistentState } from "@/lib/use-persistent-state";
import type {
  ChatApprovalRequest,
  ChatAttachment,
  ChatMessage,
  ProfileSummary,
  SessionSummary,
  SessionTag,
  TagSuggestion,
} from "@/types";

/** Map key for a not-yet-created ("New conversation") session. */
const NEW_KEY = "__new__";
const keyOf = (id: string | null): string => id ?? NEW_KEY;

export interface ChatPaneProps {
  initialSessions: SessionSummary[];
  initialSessionId: string | null;
  initialMessages: ChatMessage[];
  storageEnabled: boolean;
  /** Every profile this box serves (FG-28); one entry means no picker. */
  profiles: ProfileSummary[];
  /** The profile this pane is showing — its sessions, and its brain. */
  profile: string;
  /** Text the composer opens with (`?draft=`); never sent on its own. */
  initialDraft?: string;
}

/** Idle-watch cadence for turns started on other surfaces. */
const ACTIVE_WATCH_MS = 10_000;

/** Only user/assistant turns are shown in the visible thread. */
function visible(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

function dropTrailingEmptyAssistant(prev: ChatMessage[]): ChatMessage[] {
  const last = prev[prev.length - 1];
  return last && last.role === "assistant" && last.content === ""
    ? prev.slice(0, -1)
    : prev;
}

/** True while the latest assistant turn has streamed no text yet. */
function assistantIsEmpty(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !last || last.role !== "assistant" || last.content === "";
}

/**
 * FG-20 Wave C1 — the mobile-first one-brain chat pane. A conversation switcher
 * (sheet), a scrollable message thread, and a composer that sends one turn
 * through the `agent-home` BFF (`/api/chat/*`) to the principal-scoped Python
 * endpoint. It never talks to the AI layer or the model loop directly.
 */
export function ChatPane({
  initialSessions,
  initialSessionId,
  initialMessages,
  storageEnabled,
  profiles,
  profile,
  initialDraft,
}: ChatPaneProps) {
  const router = useRouter();
  const [switchingProfile, startProfileSwitch] = useTransition();
  // Every client read below carries the selected profile, because a profile is
  // a whole HERMES_HOME: reading the default profile's sessions while the turn
  // runs in another is what files one profile's reply in another's history.
  const path = (p: string) => withProfileQuery(p, profile);
  const payload = <T extends object>(b: T) => withProfileBody(b, profile);
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  // The user's manual left-to-right ordering of the tabs, persisted per-device
  // as a JSON string (a stable snapshot for useSyncExternalStore). The array is
  // derived and applied to whatever the server most recently returned.
  const [orderRaw, setOrderRaw] = usePersistentState<string>(
    SESSION_ORDER_STORAGE_KEY,
    "",
    (raw) => raw,
    (value) => value,
  );
  const orderedSessions = useMemo(
    () => orderSessions(sessions, parseOrder(orderRaw)),
    [sessions, orderRaw],
  );
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(visible(initialMessages));
  const [detailsSession, setDetailsSession] = useState<SessionSummary | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
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
  const threadRef = useRef<HTMLDivElement | null>(null);
  const followRef = useFollowLatest(threadRef);
  // Mirrors the selected session for use inside async stream callbacks, and
  // buffers turns whose session is not currently on screen.
  const selectedRef = useRef<string | null>(sessionId);
  const liveRef = useRef<Map<string, LiveTurn>>(new Map());
  // One AbortController per in-flight turn (keyed like the buffers) so the user
  // can stop the turn for the conversation currently on screen.
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  // ── Tagging state ──
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [sessionTags, setSessionTags] = useState<SessionTag[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<TagSuggestion[]>([]);
  const [includeTags, setIncludeTags] = useState<string[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<"any" | "all">("any");

  // ── Search state ──
  const [crossSearchOpen, setCrossSearchOpen] = useState(false);
  const [inSearchOpen, setInSearchOpen] = useState(false);
  const [highlightTerm, setHighlightTerm] = useState<string | undefined>();
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

  // Deep-linked open (notification tap / ?session=…): the transcript is
  // rendered server-side, so mark it read once on mount for the unread badge.
  useEffect(() => {
    if (initialSessionId) markSessionRead(initialSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle watch: a turn can start on the open conversation from another
  // surface (Telegram, another device, a scheduled job) or be mid-flight when
  // the page loads. While no local turn is running, poll `active` on a short
  // cadence and on wake; when a run appears, attach to its stream so the
  // reply arrives live instead of on the next manual reload. Also covers the
  // mount-time "re-attach to the in-flight turn" case the old one-shot
  // effect handled.
  const watchBusy = sendingKeys.includes(keyOf(sessionId));
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
        const data = (await res.json()) as { runId?: string | null };
        if (cancelled || !res.ok || !data.runId) return;
        attaching = true;
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

  // Register the chat header action callbacks (startNew / openArchived) into the
  // shared ref so the ChatHeaderActions component in the MobileShell header can
  // invoke them.  Runs on every render (no deps) so the ref always holds the
  // latest closures.  The cleanup resets to noops on unmount so a stale ref
  // can't fire after navigating away from the chat page.
  useEffect(() => {
    chatHeaderActionsRef.current.startNew = startNewConversation;
    chatHeaderActionsRef.current.openArchived = () => setArchivedOpen(true);
  });
  useEffect(() => {
    return () => {
      chatHeaderActionsRef.current = {
        startNew: () => {},
        openArchived: () => {},
      };
    };
  }, []);

  useEffect(() => {
    if (sendingKeys.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [sendingKeys.length]);

  const selKey = keyOf(sessionId);
  const selBusy = sendingKeys.includes(selKey);
  const selApproval = approvals[selKey] ?? null;
  const selDecision = decisions[selKey] ?? null;
  const selTurn = selBusy ? (liveActivity[selKey] ?? null) : null;
  const selRunningTool = runningTool(selTurn);
  const selActivity: ChatActivity = deriveActivity({
    busy: selBusy,
    turn: selTurn,
    approval: selApproval !== null,
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
  }, [messages, sendingKeys, selApproval, selDecision, loadingThread, liveActivity, followRef]);

  const removeSending = (k: string) =>
    setSendingKeys((prev) => prev.filter((x) => x !== k));
  function dropKey<T>(rec: Record<string, T>, k: string): Record<string, T> {
    if (!(k in rec)) return rec;
    const next = { ...rec };
    delete next[k];
    return next;
  }

  async function openConversation(id: string) {
    // Switching is allowed at any time — a turn in another session keeps
    // streaming into its own buffer and is overlaid when you return to it.
    if (id === sessionId) return;
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
          withLiveTurn(visible(body.messages ?? []), liveRef.current.get(keyOf(id))),
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
          withLiveTurn(visible(body.messages ?? []), liveRef.current.get(keyOf(id))),
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
      onCompleted: (content) => {
        setApprovals((prev) => dropKey(prev, turnKey));
        if (content) setLive(content);
      },
      onError: (message) => setError(message),
    };
  }

  /**
   * Reload mid-turn: the server-side turn outlives the page, so re-attach to
   * its stream and keep the content flowing. The transcript already ends at
   * the user message; a trailing assistant bubble is added only in that case.
   */
  async function resumeTurn(sid: string, runId: string) {
    const turnKey = keyOf(sid);
    if (sendingKeys.includes(turnKey)) return; // already attached/attaching
    setError(null);
    setSendingKeys((prev) =>
      prev.includes(turnKey) ? prev : [...prev, turnKey],
    );
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
      void refreshSessions();
    } catch {
      // The grace window may have passed; the next transcript load shows the
      // finished turn.
    } finally {
      removeSending(turnKey);
      liveRef.current.delete(turnKey);
      setApprovals((prev) => dropKey(prev, turnKey));
      setLiveActivity((prev) => dropKey(prev, turnKey));
    }
  }

  /**
   * Send one turn. Returns false only when the message never reached the
   * agent (transport failure) — the composer restores the draft on that
   * signal. A user-initiated stop resolves true: the streamed partial stays,
   * and restoring the draft would read as an error that wasn't.
   */
  async function send(text: string, attachments: ChatAttachment[]): Promise<boolean> {
    // The session this turn belongs to, captured up-front so late-arriving
    // events are attributed to their origin, not to whatever is selected later.
    const turnSessionId = sessionId;
    const turnKey = keyOf(turnSessionId);
    if (sendingKeys.includes(turnKey)) return false; // one live turn per session
    setError(null);
    setApprovals((prev) => dropKey(prev, turnKey));
    setDecisions((prev) => dropKey(prev, turnKey));
    followRef.current = true;
    setSendingKeys((prev) => [...prev, turnKey]);
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

    try {
      const { sessionId: landed } = await streamChatTurn(
        {
          sessionId: turnSessionId,
          message: text,
          attachments,
          signal: controller.signal,
          profile,
        },
        makeTurnHandlers(turnKey, setLive),
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
      void refreshSessions();
      return true;
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) {
        // The user stopped the turn. Keep whatever streamed so far; only drop a
        // trailing empty assistant bubble so we never leave a blank reply.
        if (onThisSession()) setMessages(dropTrailingEmptyAssistant);
      } else {
        if (onThisSession()) {
          setMessages((prev) => prev.slice(0, Math.max(0, prev.length - 2)));
        }
        setError(err instanceof Error ? err.message : "The message could not be sent.");
      }
      return !aborted ? false : true;
    } finally {
      // Turn is done and now persisted server-side; drop the live buffer so a
      // later re-open shows the canonical transcript, not a duplicate overlay.
      removeSending(turnKey);
      liveRef.current.delete(turnKey);
      abortRef.current.delete(turnKey);
      setApprovals((prev) => dropKey(prev, turnKey));
      setLiveActivity((prev) => dropKey(prev, turnKey));
    }
  }

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

  /**
   * Switch which profile this chat addresses. This changes the brain AND the
   * conversation list, so it navigates rather than refetching in place: the
   * server then loads that profile's sessions and transcript exactly as it does
   * on first paint, and the URL carries the choice (shareable, reload-safe).
   * Refused while a turn is streaming — navigating would abandon it.
   */
  function switchProfile(next: string) {
    if (next === profile || sendingKeys.length > 0) return;
    // In a transition so the picker can report the wait: the server has to load
    // another home's sessions and transcript, which is not instant.
    startProfileSwitch(() => {
      router.push(
        next === DEFAULT_PROFILE
          ? "/chat"
          : `/chat?profile=${encodeURIComponent(next)}`,
      );
    });
  }

  function reorderSessions(orderedIds: string[]) {
    setOrderRaw(JSON.stringify(orderedIds));
  }

  async function refreshSessions() {
    try {
      const params = new URLSearchParams();
      // Every conversation, like the first paint: a page cap would drop the
      // oldest entries of whichever categories the newest rows crowd out.
      params.set("limit", "all");
      // The strip groups cron sessions into their own "Scheduled" row
      // instead of hiding them — opt in to seeing them (see the BFF
      // route's doc comment for the empty-string-vs-absent distinction).
      params.set("exclude_sources", "");
      if (includeTags.length > 0) params.set("tags", includeTags.join(","));
      if (excludeTags.length > 0) params.set("exclude_tags", excludeTags.join(","));
      params.set("tag_match", matchMode);
      // `force`: every caller reaches here right after a mutation — a shared
      // in-flight GET could answer with pre-mutation state, and the 2 s reuse
      // window could replay it. A fresh request is the correct read here.
      const body = await fetchSessionList(
        path(`/api/chat/sessions?${params.toString()}`),
        { force: true },
      );
      if (body?.sessions) setSessions(body.sessions);
    } catch {
      // A stale conversation list is non-fatal.
    }
  }

  async function renameSession(title: string) {
    const s = detailsSession;
    if (!s) return;
    const res = await fetch("/api/chat/sessions/rename", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: s.id, title })),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new Error(body.detail ?? "The conversation could not be renamed.");
    }
    const body = (await res.json()) as { title?: string };
    const newTitle = body.title ?? title;
    setSessions((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, title: newTitle || null } : x)),
    );
    void refreshSessions();
  }

  async function setArchived(id: string, archived: boolean) {
    const res = await fetch("/api/chat/sessions/archive", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: id, archived })),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string };
      throw new Error(
        body.detail ??
          (archived
            ? "The conversation could not be archived."
            : "The conversation could not be un-archived."),
      );
    }
  }

  async function archiveSession() {
    const s = detailsSession;
    if (!s) return;
    await setArchived(s.id, true);
    // Drop it from the strip. If it was the open conversation, switch to a
    // neighbouring conversation (in display order) rather than dropping the
    // user into a blank "New conversation"; only fall back to the empty state
    // when no conversations remain.
    const nextId = nextActiveAfterArchive(
      orderedSessions.map((x) => x.id),
      s.id,
    );
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    if (sessionId === s.id) {
      if (nextId) void openConversation(nextId);
      else startNewConversation();
    }
    void refreshSessions();
  }

  async function unarchiveSession(id: string) {
    await setArchived(id, false);
    void refreshSessions();
  }

  // ── Tag handlers ──────────────────────────────────────────────────

  async function loadAllTags() {
    try {
      const res = await fetch(path("/api/chat/sessions/tags"), { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { tags?: SessionTag[] };
        if (body.tags) setAllTags(body.tags);
      }
    } catch { /* non-fatal */ }
  }

  // Load session tags when the SessionModal opens.
  async function onOpenDetails(s: SessionSummary) {
    setDetailsSession(s);
    setTagSuggestions([]);
    setSessionTags([]);
    if (s.id) {
      try {
        const res = await fetch(
          path(`/api/chat/sessions/tags/get?sessionId=${encodeURIComponent(s.id)}`),
          { cache: "no-store" },
        );
        if (res.ok) {
          const body = (await res.json()) as { tags?: SessionTag[] };
          if (body.tags) setSessionTags(body.tags);
        }
      } catch { /* non-fatal */ }
    }
  }

  async function addTag(name: string) {
    const s = detailsSession;
    if (!s) return;
    const res = await fetch("/api/chat/sessions/tags/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: s.id, name })),
    });
    if (!res.ok) throw new Error("Failed to add tag.");
    const body = (await res.json()) as { tag?: SessionTag };
    if (body.tag) {
      setSessionTags((prev) =>
        prev.some((t) => t.name === body.tag!.name)
          ? prev
          : [...prev, body.tag!],
      );
      void loadAllTags();
    }
  }

  async function removeTag(tagId: string) {
    const s = detailsSession;
    if (!s) return;
    const res = await fetch("/api/chat/sessions/tags/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: s.id, tagId })),
    });
    if (!res.ok) throw new Error("Failed to remove tag.");
    setSessionTags((prev) => prev.filter((t) => t.id !== tagId));
    void loadAllTags();
  }

  /** Move the open conversation to a different category. Stored as a
   * reserved `category:<value>` tag (see `lib/chat/categorize.ts`) — a
   * session should carry at most one, so any existing override is removed
   * before the new one is added. Refreshes the strip afterward so it
   * regroups immediately instead of waiting for the next natural refresh. */
  async function setSessionCategory(next: ChatCategory) {
    const existing = sessionTags.find((t) => isCategoryOverrideTag(t));
    if (existing) {
      await removeTag(existing.id);
    }
    await addTag(categoryOverrideTagName(next));
    void refreshSessions();
  }

  async function suggestTags() {
    const s = detailsSession;
    if (!s) return;
    const res = await fetch("/api/chat/sessions/tags/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: s.id })),
    });
    if (!res.ok) throw new Error("Failed to suggest tags.");
    const body = (await res.json()) as { suggestions?: TagSuggestion[] };
    setTagSuggestions(body.suggestions ?? []);
  }

  async function acceptSuggestion(suggestion: TagSuggestion) {
    const s = detailsSession;
    if (!s) return;
    const res = await fetch("/api/chat/sessions/tags/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload({ sessionId: s.id, name: suggestion.tag_name })),
    });
    if (!res.ok) throw new Error("Failed to add tag.");
    const body = (await res.json()) as { tag?: SessionTag };
    if (body.tag) {
      setSessionTags((prev) =>
        prev.some((t) => t.name === body.tag!.name)
          ? prev
          : [...prev, body.tag!],
      );
      void loadAllTags();
    }
    setTagSuggestions((prev) => prev.filter((t) => t !== suggestion));
  }

  async function dismissSuggestion(suggestion: TagSuggestion) {
    setTagSuggestions((prev) => prev.filter((t) => t !== suggestion));
  }

  // Auto-suggest tags when opening the SessionModal if the session has 5+ messages.
  useEffect(() => {
    if (!detailsSession || detailsSession.message_count < 5 || tagSuggestions.length > 0) {
      return;
    }
    const t = setTimeout(() => void suggestTags(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsSession]);

  // Load all tags on mount.
  useEffect(() => {
    const t = setTimeout(() => void loadAllTags(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Tag filter handlers ──

  function toggleTagFilter(name: string) {
    if (includeTags.includes(name)) {
      // include → exclude
      setIncludeTags((prev) => prev.filter((n) => n !== name));
      setExcludeTags((prev) => [...prev, name]);
    } else if (excludeTags.includes(name)) {
      // exclude → clear
      setExcludeTags((prev) => prev.filter((n) => n !== name));
    } else {
      // none → include
      setIncludeTags((prev) => [...prev, name]);
    }
  }

  // Re-fetch sessions when tag filter changes.
  useEffect(() => {
    void refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeTags, excludeTags, matchMode]);

  // ── Search handlers ──────────────────────────────────────────────

  async function crossSessionSearch(q: string) {
    const res = await fetch(
      path(`/api/chat/sessions/search?q=${encodeURIComponent(q)}`),
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      results?: Array<{
        session_id: string;
        snippet: string;
        role: string;
        title?: string | null;
      }>;
    };
    return body.results ?? [];
  }

  async function jumpToSearchResult(
    result: { session_id: string; snippet: string },
  ) {
    await openConversation(result.session_id);
    // After loading, highlight the snippet text in the message list.
    const term = result.snippet
      .replace(/>>>/g, "")
      .replace(/<<</g, "")
      .trim()
      .slice(0, 30);
    setHighlightTerm(term);
    setInSearchOpen(true);
  }

  return (
    <div data-component="ChatPane" className="flex min-h-0 flex-1 flex-col">
      {/* Which profile answers — switching reloads that profile's chats. */}
      <ProfilePicker
        profiles={profiles}
        selected={profile}
        onSelect={switchProfile}
        disabled={sendingKeys.length > 0}
        switching={switchingProfile}
      />

      {/* Tag filter bar */}
      <TagFilterBar
        tags={allTags}
        includeTags={includeTags}
        excludeTags={excludeTags}
        matchMode={matchMode}
        onToggle={toggleTagFilter}
        onMatchModeChange={setMatchMode}
      />

      {/* Search toggle buttons */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1">
        <button
          type="button"
          onClick={() => {
            setCrossSearchOpen((v) => !v);
            setInSearchOpen(false);
          }}
          className={`rounded-lg px-2 py-0.5 text-xs ${
            crossSearchOpen
              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "text-[var(--color-muted)] border border-[var(--color-border)]"
          }`}
        >
          🔍 All sessions
        </button>
        {sessionId && (
          <button
            type="button"
            onClick={() => {
              setInSearchOpen((v) => !v);
              setCrossSearchOpen(false);
              setHighlightTerm(undefined);
            }}
            className={`rounded-lg px-2 py-0.5 text-xs ${
              inSearchOpen
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-muted)] border border-[var(--color-border)]"
            }`}
          >
            🔍 In conversation
          </button>
        )}
      </div>

      {/* Cross-session search bar */}
      {crossSearchOpen && (
        <SessionSearchBar
          onSearch={crossSessionSearch}
          onJumpToResult={(result) => void jumpToSearchResult(result)}
          onClose={() => setCrossSearchOpen(false)}
        />
      )}

      {/* In-session search bar */}
      {inSearchOpen && (
        <InSessionSearch
          messages={messages}
          onClose={() => {
            setInSearchOpen(false);
            setHighlightTerm(undefined);
          }}
          highlightRef={highlightCallbackRef}
        />
      )}

      <SessionTabs
        sessions={orderedSessions}
        activeId={sessionId}
        busyKeys={sendingKeys}
        onSelect={openConversation}
        onOpenDetails={onOpenDetails}
        onNew={startNewConversation}
        onReorder={reorderSessions}
      />

      <div
        ref={threadRef}
        className="min-h-[42dvh] max-h-[calc(100dvh-19rem)] flex-1 space-y-3 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
      >
        {loadingThread ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted)]">
            Loading conversation…
          </p>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted)]">
            {sessionId
              ? "No messages yet — say hello."
              : "Start a new conversation with your agent."}
          </p>
        ) : (
          messages
            .filter((m) => m.role !== "assistant" || m.content !== "")
            .map((m, i) => (
              <MessageBubble
                key={m.id ?? i}
                message={m}
                msgIndex={i}
                highlightTerm={highlightTerm}
              />
            ))
        )}
        {selDecision ? (
          <div
            data-component="DecisionNotice"
            className="flex justify-start"
          >
            <span className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-muted)]">
              {selDecision}
            </span>
          </div>
        ) : null}
        <LiveActivity
          reasoning={liveActivity[selKey]?.reasoning ?? ""}
          tools={liveActivity[selKey]?.tools ?? []}
        />
        <StatusIndicator
          activity={selActivity}
          detail={selRunningTool?.name}
          elapsedMs={selTurn ? now - selTurn.startedAt : undefined}
          quietMs={selTurn ? now - selTurn.lastEventAt : undefined}
          hasOutput={!assistantIsEmpty(messages)}
        />
      </div>

      {error ? (
        <p className="mt-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <Composer
        sending={selBusy}
        storageEnabled={storageEnabled}
        sessionId={sessionId}
        initialText={initialDraft}
        onSend={send}
        onStop={() => void stopTurn()}
        stopping={selTurn?.stopping ?? false}
      />

      {detailsSession ? (
        <SessionModal
          session={detailsSession}
          onClose={() => {
            setDetailsSession(null);
            setTagSuggestions([]);
            setSessionTags([]);
          }}
          onRename={renameSession}
          onArchive={archiveSession}
          category={categorizeSession({ ...detailsSession, tags: sessionTags })}
          onSetCategory={setSessionCategory}
          tags={sessionTags}
          allTags={allTags}
          tagSuggestions={tagSuggestions}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onAcceptSuggestion={acceptSuggestion}
          onDismissSuggestion={dismissSuggestion}
        />
      ) : null}

      {archivedOpen ? (
        <ArchivedModal
          onClose={() => setArchivedOpen(false)}
          onUnarchive={unarchiveSession}
          profile={profile}
        />
      ) : null}

      {selApproval ? (
        <ApprovalModal
          request={selApproval}
          busy={resolvingApproval}
          onResolve={resolveApprovalOnce}
        />
      ) : null}
    </div>
  );
}
