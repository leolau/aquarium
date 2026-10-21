"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { ActivityLine } from "@/components/chat/thread/ActivityLine";
import { ApprovalCard } from "@/components/chat/thread/ApprovalCard";
import { StreamingMarkdown } from "@/components/chat/thread/StreamingMarkdown";
import { useStickToBottom } from "@/components/chat/thread/useStickToBottom";
import {
  keyOf,
  useBusyKeys,
  useLiveTurn,
  useThread,
  type ChatController,
} from "@/lib/chat/chat-controller";
import type { ChatMessage } from "@/types";

export interface ChatThreadProps {
  controller: ChatController;
  /** Thread to show (null = new conversation → key NEW_KEY). */
  sessionId: string | null;
  /** In-session search highlight (passed to MessageBubble). */
  highlightTerm?: string;
  /** Shown when there are no messages and nothing live. */
  empty?: ReactNode;
  /** The component IS the single scroll container. */
  className?: string;
  /** compact = lead panel. */
  density?: "comfortable" | "compact";
}

/** Older pages start loading this far before the top edge comes into view. */
const OLDER_ROOT_MARGIN = "600px 0px 0px 0px";

const rowKey = (m: ChatMessage, i: number): string =>
  m.id != null ? String(m.id) : (m.clientKey ?? `idx-${i}`);

/**
 * The transcript. Memoized on `messages` + `highlightTerm` only, so a
 * streamed token (which never changes the thread snapshot) skips it entirely.
 * `msgIndex` is the index in `thread.messages` — InSessionSearch matches on
 * that array and scrolls to `[data-msg-index]`.
 */
const History = memo(function History({
  messages,
  highlightTerm,
}: {
  messages: ChatMessage[];
  highlightTerm?: string;
}) {
  return (
    <>
      {messages.map((m, i) => (
        <MessageBubble
          key={rowKey(m, i)}
          message={m}
          msgIndex={i}
          highlightTerm={highlightTerm}
        />
      ))}
    </>
  );
});

/**
 * The in-flight reply: the only part of the thread subscribed to the live
 * turn, so per-frame streaming updates re-render just this subtree.
 */
const LiveTurn = memo(function LiveTurn({
  controller,
  turnKey,
  compact,
}: {
  controller: ChatController;
  turnKey: string;
  compact: boolean;
}) {
  const live = useLiveTurn(controller, turnKey);
  const resolve = useCallback(
    (choice: string) => controller.resolveApproval(turnKey, choice),
    [controller, turnKey],
  );
  if (!live) return null;
  const text = live.assistantText;
  return (
    <div data-component="LiveTurn" className={compact ? "space-y-1.5" : "space-y-2"}>
      {text !== "" ? (
        <div data-component="LiveReply" className="flex justify-start">
          <div
            className={`max-w-[85%] break-words rounded-2xl bg-[var(--color-surface-2)] px-3 py-2 text-[var(--color-fg)] ${
              compact ? "text-[13px]" : "text-sm"
            }`}
          >
            <StreamingMarkdown content={text} streaming />
          </div>
        </div>
      ) : null}
      <ActivityLine
        activity={live.phase}
        tools={live.activity.tools}
        reasoning={live.activity.reasoning}
        startedAt={live.activity.startedAt}
        lastEventAt={live.activity.lastEventAt}
        hasOutput={text !== ""}
      />
      {live.approval ? (
        <ApprovalCard
          request={live.approval}
          busy={live.resolvingApproval}
          onResolve={resolve}
        />
      ) : null}
    </div>
  );
});

function ThreadSkeleton() {
  return (
    <div
      data-component="ThreadSkeleton"
      aria-busy="true"
      aria-label="Loading conversation"
      className="space-y-3"
    >
      {["w-2/3", "ml-auto w-1/2", "w-3/4"].map((w) => (
        <div
          key={w}
          className={`h-10 animate-pulse rounded-2xl bg-[var(--color-surface-2)] ${w}`}
        />
      ))}
    </div>
  );
}

/**
 * One conversation thread, shared by the main chat pane and the lead panel.
 * It is the single scroll container: older pages load from a top sentinel
 * (or the "Load earlier" button) without moving the viewport, the view only
 * follows new content while the reader is at the bottom, and a "New
 * messages" pill offers the way back otherwise.
 */
export function ChatThread({
  controller,
  sessionId,
  highlightTerm,
  empty,
  className = "",
  density = "comfortable",
}: ChatThreadProps) {
  const thread = useThread(controller, sessionId);
  const busyKeys = useBusyKeys(controller);
  const key = keyOf(sessionId);
  const busy = busyKeys.includes(key);
  const compact = density === "compact";

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stick = useStickToBottom(scrollRef, contentRef);
  const { scrollToBottom, preservePrepend } = stick;
  const atBottomRef = useRef(stick.atBottom);
  useEffect(() => {
    atBottomRef.current = stick.atBottom;
  }, [stick.atBottom]);

  const { messages, hasMore, loadingOlder, status, error, note } = thread;

  const loadOlder = useCallback(() => {
    if (!sessionId) return;
    const t = controller.getThread(sessionId);
    if (!t.hasMore || t.loadingOlder) return;
    // At the bottom the growth pins anyway; restoring an offset measured
    // before the first pin would leave the reader at the top instead.
    if (!atBottomRef.current) preservePrepend();
    void controller.loadOlder(sessionId);
  }, [controller, sessionId, preservePrepend]);

  // Auto-load older pages as the top comes near. Re-created after each page
  // so a sentinel still in range keeps paging; paused after a failure.
  const autoOlder = hasMore && !loadingOlder && !error && status === "ready";
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!autoOlder || !root || !target || typeof IntersectionObserver === "undefined") {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root, rootMargin: OLDER_ROOT_MARGIN },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [autoOlder, loadOlder]);

  // A different conversation starts at its newest message.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [sessionId, scrollToBottom]);

  // Sending a message brings the reader to it.
  const last = messages[messages.length - 1];
  const lastSeen = useRef(last);
  useLayoutEffect(() => {
    if (last === lastSeen.current) return;
    lastSeen.current = last;
    if (last?.role === "user" && last.clientKey && last.id == null) scrollToBottom();
  }, [last, scrollToBottom]);

  // An idle thread with an id has simply not been opened yet.
  const pending = status === "loading" || (status === "idle" && sessionId !== null);
  const showSkeleton = pending && messages.length === 0 && !busy;
  const showEmpty = !pending && messages.length === 0 && !busy && !error;

  return (
    <div
      ref={scrollRef}
      data-component="ChatThread"
      data-density={density}
      role="region"
      aria-label="Conversation"
      tabIndex={0}
      className={`min-h-0 flex-1 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${className}`}
    >
      <div
        ref={contentRef}
        className={
          compact
            ? "space-y-2 [&_[data-component=MessageBubble]>div]:text-[13px]"
            : "space-y-3"
        }
      >
        {hasMore ? (
          <div data-component="LoadEarlier" className="flex flex-col items-center gap-1">
            <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
            {loadingOlder ? (
              <span role="status" className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]"
                />
                <span className="sr-only">Loading earlier messages…</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={loadOlder}
                className="rounded-full px-3 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
              >
                Load earlier messages
              </button>
            )}
          </div>
        ) : null}

        {showSkeleton ? <ThreadSkeleton /> : null}
        {showEmpty ? empty ?? null : null}

        <History messages={messages} highlightTerm={highlightTerm} />
        <LiveTurn controller={controller} turnKey={key} compact={compact} />

        {note ? (
          <div data-component="DecisionNotice" className="flex justify-start">
            <span className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-muted)]">
              {note}
            </span>
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-component="ThreadError"
            className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        ) : null}
      </div>

      {stick.hasNew ? (
        <div className="pointer-events-none sticky bottom-0 flex h-0 justify-center">
          <button
            type="button"
            aria-label="Jump to latest"
            onClick={() => scrollToBottom(true)}
            className="pointer-events-auto absolute bottom-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-fg)] shadow-md"
          >
            New messages ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}
