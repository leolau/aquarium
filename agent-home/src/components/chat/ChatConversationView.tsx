"use client";

import { ApprovalCard } from "@/components/chat/thread/ApprovalCard";
import { Composer } from "@/components/chat/Composer";
import { LiveActivity } from "@/components/chat/LiveActivity";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { StatusIndicator } from "@/components/chat/StatusIndicator";
import {
  assistantIsEmpty,
  type ChatConversation,
} from "@/components/chat/useChatConversation";

/**
 * The open conversation's transcript, live activity, approval card, error
 * line and composer, driven by {@link useChatConversation}. Used by the chat
 * page and the landing page's inline chat.
 */
export function ChatConversationView({
  conv,
  storageEnabled,
  composerInitialText,
}: {
  conv: ChatConversation;
  storageEnabled: boolean;
  composerInitialText?: string;
}) {
  const {
    sessionId,
    messages,
    loadingThread,
    error,
    now,
    liveActivity,
    selKey,
    selBusy,
    selApproval,
    selDecision,
    selTurn,
    selRunningTool,
    selActivity,
    resolvingApproval,
    threadRef,
    highlightTerm,
  } = conv;

  return (
    <>
      <div
        ref={threadRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
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
        {selApproval ? (
          <ApprovalCard
            request={selApproval}
            busy={resolvingApproval}
            onResolve={conv.resolveApproval}
          />
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <Composer
        sending={selBusy}
        storageEnabled={storageEnabled}
        sessionId={sessionId}
        initialText={composerInitialText}
        onSend={conv.send}
        onStop={() => void conv.stopTurn()}
        stopping={selTurn?.stopping ?? false}
      />
    </>
  );
}
