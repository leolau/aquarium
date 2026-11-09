"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { DEFAULT_PROFILE } from "@/components/chat/ProfilePicker";
import type { ProfileSummary } from "@/types";

import { chatHref, chatsApi } from "./chatsApi";
import { ArrowRightIcon, MessageIcon, XIcon } from "@/components/ui/icons";
import { isPinned, matchesQuery, type LandingSession } from "./model";
import { NewChatButton, profileLabel } from "./NewChatButton";
import { PinSuggestionCard } from "./PinSuggestionCard";
import { SessionRow } from "./SessionRow";
import { MessageSearchSection, type MessageSearchFn, type MessageSearchHit } from "./MessageSearch";
import { SessionSearch } from "./SessionSearch";
import { useLandingChats } from "./useLandingChats";
import { useUndoToast } from "@/components/ui/UndoToast";
import { useT } from "@/i18n";
import {
  CHAT_CATEGORY_ORDER,
  categorizeSession,
  type ChatCategory,
} from "@/lib/chat/categorize";

/** Recent rows shown before "All chats" takes over. */
export const RECENT_LIMIT = 30;

export interface ChatsPanelProps {
  /** The session's profile; the list, pins and suggestions are scoped to it. */
  profile?: string;
  /** Enrolled profiles (skip to have the panel read `/api/chat/profiles`). */
  profiles?: ProfileSummary[];
  /** Highlights the conversation that is open, if any. */
  activeSessionId?: string | null;
  /** Server-rendered first page, so the list paints without a fetch. */
  initialSessions?: LandingSession[];
  /** Where "All chats" goes. */
  allChatsHref?: string;
  fetchImpl?: typeof fetch;
  /** Show category chips (All / Kanban / Daily / Scheduled / Others) that filter the list. */
  categoryFilter?: boolean;
  /** Also search inside every conversation's messages (needs `onOpenMessageHit`). */
  messageSearch?: MessageSearchFn;
  /** Opens the chat a message hit belongs to. */
  onOpenMessageHit?: (hit: MessageSearchHit) => void;
  /** Open a row's chat in place (the landing page) instead of on `/chat`. */
  onOpenChat?: (session: LandingSession) => void;
  /** A row was renamed (the new title, trimmed; empty when cleared). */
  onRenamed?: (session: LandingSession, title: string) => void;
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <h3 className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase leading-[14px] tracking-wide text-[var(--color-muted)]">
      {label}
      {count ? <span>{count}</span> : null}
    </h3>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-1">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex flex-col gap-1.5 px-3 py-2">
          <span className="h-3.5 w-3/4 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
          <span className="h-3 w-1/3 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div
      data-component="ChatsEmpty"
      className="flex flex-col items-center gap-2 px-4 py-6 text-center"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/illustrations/empty-sessions@2x.png"
        alt=""
        width={160}
        height={120}
        className="h-auto w-40"
      />
      <p className="text-[13px] font-medium text-[var(--color-fg)]">No chats yet</p>
      <p className="text-xs text-[var(--color-muted)]">
        Start one with New chat — it will show up here.
      </p>
    </div>
  );
}

/**
 * The chats list shared by the desktop sidebar and the mobile drawer
 * (Figma `sessions-sidebar` in 5:2, `chats-drawer` in 6:195).
 */
export function ChatsPanel({
  profile = DEFAULT_PROFILE,
  profiles: givenProfiles,
  activeSessionId = null,
  initialSessions,
  allChatsHref = "/chat",
  fetchImpl = fetch,
  searchShortcut = false,
  onNavigate,
  searchId,
  categoryFilter = false,
  messageSearch,
  onOpenMessageHit,
  onOpenChat,
  onRenamed,
}: ChatsPanelProps & {
  searchShortcut?: boolean | "hint";
  onNavigate?: () => void;
  searchId?: string;
}) {
  const chats = useLandingChats({ profile, initialSessions, fetchImpl });
  const [query, setQuery] = useState("");
  const [fetchedProfiles, setFetchedProfiles] = useState<ProfileSummary[]>([]);
  const profiles = givenProfiles ?? fetchedProfiles;

  useEffect(() => {
    if (givenProfiles) return;
    let cancelled = false;
    void chatsApi.profiles(fetchImpl).then((p) => {
      if (!cancelled && p) setFetchedProfiles(p);
    });
    return () => {
      cancelled = true;
    };
  }, [givenProfiles, fetchImpl]);

  const label = profileLabel(profile);
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? [...chats.pinned, ...chats.recent].filter((s) => matchesQuery(s, query)) : []),
    [searching, chats.pinned, chats.recent, query],
  );
  const t = useT("chatPage");
  const [category, setCategory] = useState<ChatCategory | "all">("all");
  const inCategory = (s: LandingSession) =>
    !categoryFilter || category === "all" || categorizeSession(s) === category;
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    if (!categoryFilter) return counts;
    for (const s of [...chats.pinned, ...chats.recent]) {
      counts.all += 1;
      const c = categorizeSession(s);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [categoryFilter, chats.pinned, chats.recent]);
  const { show: showUndo, toast } = useUndoToast();
  const { togglePin } = chats;
  const onTogglePin = async (s: LandingSession) => {
    const wasPinned = isPinned(s);
    if (!(await togglePin(s))) return;
    showUndo(t(wasPinned ? "unpinnedToast" : "pinnedToast"), () =>
      togglePin({ ...s, pinned_at: wasPinned ? null : Date.now() / 1000 }),
    );
  };
  const pinned = chats.pinned.filter(inCategory);
  const recent = chats.recent.filter(inCategory).slice(0, RECENT_LIMIT);
  const empty = !chats.loading && chats.sessions.filter((s) => !s.archived).length === 0;

  const row = (s: LandingSession) => (
    <SessionRow
      key={s.id}
      session={s}
      href={chatHref(s.id, s.profile ?? profile)}
      profileLabel={label}
      active={s.id === activeSessionId}
      canPin={chats.canPin}
      busy={chats.busyIds.has(s.id)}
      onTogglePin={(s) => void onTogglePin(s)}
      onRename={async (session, title) => {
        const ok = await chats.rename(session, title);
        if (ok) onRenamed?.(session, title.trim());
        return ok;
      }}
      onNavigate={onNavigate}
      onOpen={onOpenChat}
    />
  );

  return (
    <div data-component="ChatsPanel" className="flex min-h-0 flex-1 flex-col gap-2">
      <NewChatButton currentProfile={profile} profiles={profiles} onStarted={onNavigate} fetchImpl={fetchImpl} />
      <SessionSearch value={query} onChange={setQuery} shortcut={searchShortcut} id={searchId} />

      {categoryFilter && !searching ? (
        <div
          role="group"
          aria-label={t("categories")}
          data-component="ChatCategoryFilter"
          className="flex flex-wrap gap-1.5"
        >
          {(["all", ...CHAT_CATEGORY_ORDER] as const).map((c) => (
            <button
              key={c}
              type="button"
              data-action="filter-category"
              data-category={c}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={`inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium ${
                category === c
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
              }`}
            >
              {t(`category.${c}`)}
              <span className="tabular-nums opacity-70">{categoryCounts[c] ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      {chats.error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-danger)]"
        >
          <span className="min-w-0 flex-1">{chats.error}</span>
          <button type="button" onClick={chats.clearError} aria-label="Dismiss error">
            <XIcon size={12} />
          </button>
        </div>
      ) : null}

      {!searching ? (
        <PinSuggestionCard
          suggestions={chats.suggestions}
          busy={chats.busyIds.has("suggestions")}
          onAccept={(ids) => void chats.acceptSuggestions(ids)}
          onDismiss={(ids) => void chats.dismissSuggestions(ids)}
        />
      ) : null}

      <nav aria-label="Chats" className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        {chats.loading ? (
          <SkeletonRows />
        ) : chats.failed ? (
          <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
            Chats couldn't be loaded.{" "}
            <button type="button" onClick={() => void chats.refresh()} className="underline">
              Try again
            </button>
          </p>
        ) : empty ? (
          <EmptyState />
        ) : searching ? (
          <>
            <SectionHeader label="Results" count={results.length} />
            {results.length ? (
              <ul className="flex flex-col">{results.map(row)}</ul>
            ) : (
              <p className="px-3 py-2 text-xs text-[var(--color-muted)]">No chats match “{query.trim()}”.</p>
            )}
            {messageSearch && onOpenMessageHit ? (
              <MessageSearchSection
                query={query}
                search={messageSearch}
                onOpen={onOpenMessageHit}
                onNavigate={onNavigate}
              />
            ) : null}
          </>
        ) : (
          <>
            {pinned.length ? (
              <section aria-label="Pinned chats" className="flex flex-col">
                <SectionHeader label="Pinned" count={pinned.length} />
                <ul className="flex flex-col">{pinned.map(row)}</ul>
              </section>
            ) : null}
            {recent.length ? (
              <section aria-label="Recent chats" className="flex flex-col">
                <SectionHeader label="Recent" />
                <ul className="flex flex-col">{recent.map(row)}</ul>
              </section>
            ) : null}
            {categoryFilter && !pinned.length && !recent.length ? (
              <p className="px-3 py-2 text-xs text-[var(--color-muted)]">{t("categoryEmpty")}</p>
            ) : null}
          </>
        )}
      </nav>

      <Link
        href={allChatsHref}
        onClick={onNavigate}
        data-component="AllChatsButton"
        className="mt-auto inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] font-medium leading-[18px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
      >
        <MessageIcon size={16} />
        All chats
        <ArrowRightIcon size={14} className="text-[var(--color-muted)]" />
      </Link>
      {toast}
    </div>
  );
}
