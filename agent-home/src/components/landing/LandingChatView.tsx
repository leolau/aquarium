"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { ChatConversationView } from "@/components/chat/ChatConversationView";
import { useChatConversation } from "@/components/chat/useChatConversation";
import { ArrowRightIcon, ChevronLeftIcon, XIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";

import { chatHref, chatsApi } from "./chats/chatsApi";
import { displayTitle, type LandingSession } from "./chats/model";

/** A plain left click (no modifier): handled in place, not as a page load. */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * A conversation opened in the landing page's centre column (`/?chat=<id>`).
 * The transcript, send/stream/stop and approvals are the chat page's own
 * ({@link useChatConversation}); the header adds Back to the composer (its
 * logical parent, Home) and a link to the full chat page.
 */
export function LandingChatView({
  sessionId,
  profile,
  title,
  renamedTitle,
  highlight,
  storageEnabled,
  onClose,
}: {
  sessionId: string;
  profile: string;
  /** Title known from the row or hit that opened it (shown until the list loads). */
  title?: string | null;
  /** The title just saved from the sidebar ("" when cleared), until the list catches up. */
  renamedTitle?: string;
  /** Message-search words to highlight. */
  highlight?: string;
  storageEnabled: boolean;
  onClose: () => void;
}) {
  const t = useT("chatPage");
  const [sessions, setSessions] = useState<LandingSession[] | null>(null);
  const refresh = useCallback(async () => {
    const list = await chatsApi.sessions(profile, { force: true });
    if (list) setSessions(list);
  }, [profile]);
  useEffect(() => {
    let cancelled = false;
    void chatsApi.sessions(profile).then((list) => {
      if (!cancelled && list) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const conv = useChatConversation({
    profile,
    initialSessionId: sessionId,
    initialMessages: [],
    initialHighlight: highlight,
    loadOnMount: true,
    findSession: (id) => sessions?.find((s) => s.id === id),
    onSessionsStale: () => void refresh(),
  });
  useEffect(() => {
    if (renamedTitle === undefined) return;
    setSessions(
      (prev) =>
        prev?.map((s) => (s.id === sessionId ? { ...s, title: renamedTitle || null } : s)) ?? prev,
    );
  }, [renamedTitle, sessionId]);
  const session = sessions?.find((s) => s.id === sessionId);
  const heading = session
    ? displayTitle(session).text
    : renamedTitle?.trim() || title?.trim() || t("inlineChat.untitled");

  return (
    <section
      data-component="LandingChat"
      aria-labelledby="landing-chat-title"
      className="flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col"
    >
      <header data-component="LandingChatHeader" className="mb-3 flex min-w-0 items-center gap-2">
        <Link
          href="/"
          data-action="back"
          aria-label={t("inlineChat.back")}
          onClick={(e) => {
            if (!isPlainClick(e)) return;
            e.preventDefault();
            onClose();
          }}
          className="-ml-2 inline-flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] lg:h-8"
        >
          <ChevronLeftIcon size={18} />
          <span aria-hidden="true" className="hidden lg:inline">
            {t("inlineChat.home")}
          </span>
        </Link>
        <h2
          id="landing-chat-title"
          className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--color-fg)]"
        >
          {heading}
        </h2>
        <Link
          href={chatHref(sessionId, profile)}
          data-action="open-full-page"
          className="inline-flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] lg:h-8"
        >
          {t("inlineChat.openFullPage")}
          <ArrowRightIcon size={14} className="text-[var(--color-muted)]" />
        </Link>
      </header>

      {conv.highlightTerm ? (
        <div
          data-component="LandingChatHighlight"
          className="mb-2 flex min-w-0 items-center gap-2 self-start rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] py-0.5 pl-3 pr-1 text-xs text-[var(--color-muted)]"
        >
          <span className="min-w-0 truncate">
            {t("inlineChat.highlighting", { term: conv.highlightTerm })}
          </span>
          <button
            type="button"
            aria-label={t("inlineChat.clearHighlight")}
            onClick={() => conv.setHighlightTerm(undefined)}
            className="grid size-6 shrink-0 place-items-center rounded-full hover:text-[var(--color-fg)] lg:!min-h-0"
          >
            <XIcon size={12} />
          </button>
        </div>
      ) : null}

      {/* The landing dock already keeps the composer clear of the launcher. */}
      <ChatConversationView
        conv={conv}
        storageEnabled={storageEnabled}
        composerLauncherClearance={false}
      />
    </section>
  );
}
