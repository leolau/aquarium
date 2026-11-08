"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { DEFAULT_PROFILE } from "@/components/chat/ProfilePicker";
import type { ProfileSummary } from "@/types";

import { chatHref, chatsApi } from "./chatsApi";
import { ArrowRightIcon, MessageIcon, XIcon } from "./icons";
import { matchesQuery, type LandingSession } from "./model";
import { NewChatButton, profileLabel } from "./NewChatButton";
import { PinSuggestionCard } from "./PinSuggestionCard";
import { SessionRow } from "./SessionRow";
import { SessionSearch } from "./SessionSearch";
import { useLandingChats } from "./useLandingChats";

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
}: ChatsPanelProps & {
  searchShortcut?: boolean;
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
  const recent = chats.recent.slice(0, RECENT_LIMIT);
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
      onTogglePin={chats.togglePin}
      onRename={chats.rename}
      onNavigate={onNavigate}
    />
  );

  return (
    <div data-component="ChatsPanel" className="flex min-h-0 flex-1 flex-col gap-2">
      <NewChatButton currentProfile={profile} profiles={profiles} onStarted={onNavigate} fetchImpl={fetchImpl} />
      <SessionSearch value={query} onChange={setQuery} shortcut={searchShortcut} id={searchId} />

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
          </>
        ) : (
          <>
            {chats.pinned.length ? (
              <section aria-label="Pinned chats" className="flex flex-col">
                <SectionHeader label="Pinned" count={chats.pinned.length} />
                <ul className="flex flex-col">{chats.pinned.map(row)}</ul>
              </section>
            ) : null}
            {recent.length ? (
              <section aria-label="Recent chats" className="flex flex-col">
                <SectionHeader label="Recent" />
                <ul className="flex flex-col">{recent.map(row)}</ul>
              </section>
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
    </div>
  );
}
