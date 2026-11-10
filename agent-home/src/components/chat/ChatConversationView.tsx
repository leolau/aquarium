"use client";

import { useEffect, useRef, useState } from "react";

import { ApprovalCard } from "@/components/chat/thread/ApprovalCard";
import { Composer } from "@/components/chat/Composer";
import { LiveActivity } from "@/components/chat/LiveActivity";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { StatusIndicator } from "@/components/chat/StatusIndicator";
import { RefBadge } from "@/components/refs/RefBadge";
import { chatTranscriptText, copyText } from "@/lib/chat/copy-chat";
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
  composerLauncherClearance = true,
  sessionRef,
}: {
  conv: ChatConversation;
  storageEnabled: boolean;
  composerInitialText?: string;
  composerLauncherClearance?: boolean;
  /** The open chat's short ref (`C1024`), shown above the transcript. */
  sessionRef?: string | null;
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
  const live = liveActivity[selKey];
  const canCopy =
    messages.length > 0 || (live?.tools.length ?? 0) > 0 || (live?.reasoning ?? "") !== "";

  return (
    <>
      {canCopy || sessionRef ? (
        <div className="mb-1 flex items-center justify-end gap-2">
          <RefBadge value={sessionRef} className="lg:!min-h-0" />
          {canCopy ? (
            <CopyChatButton
              getText={() =>
                chatTranscriptText(
                  messages,
                  live ? { tools: live.tools, reasoning: live.reasoning } : null,
                )
              }
            />
          ) : null}
        </div>
      ) : null}
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
        launcherClearance={composerLauncherClearance}
      />
    </>
  );
}

/** Copies the whole conversation, including each turn's reasoning and the live activity. */
function CopyChatButton({ getText }: { getText: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(getText());
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  };
  return (
    <button
      type="button"
      data-action="copy-chat"
      aria-label="Copy entire chat"
      title="Copy the whole conversation, including agent activity"
      onClick={() => void copy()}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:!min-h-0"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy chat"}
    </button>
  );
}
