"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/i18n";

import { ChatsDrawer, ChatsSidebar } from "@/components/landing/chats";
import { chatHref, chatsApi } from "@/components/landing/chats/chatsApi";
import { highlightTermOf } from "@/components/landing/chats/MessageSearch";
import { MessageIcon, PlusIcon } from "@/components/ui/icons";
import { ArchivedModal } from "@/components/chat/ArchivedModal";
import {
  CHAT_FILTERS_OPEN_STORAGE_KEY,
  ChatFiltersPanel,
  parseFiltersOpen,
  serializeFiltersOpen,
} from "@/components/chat/ChatFiltersPanel";
import { ChatConversationView } from "@/components/chat/ChatConversationView";
import { InSessionSearch } from "@/components/chat/InSessionSearch";
import { SessionModal } from "@/components/chat/SessionModal";
import { TagFilterBar } from "@/components/chat/TagFilterBar";
import { useChatConversation } from "@/components/chat/useChatConversation";
import {
  categorizeSession,
  categoryOverrideTagName,
  isCategoryOverrideTag,
  type ChatCategory,
} from "@/lib/chat/categorize";
import { chatHeaderActionsRef } from "@/lib/chat/header-actions";
import {
  nextActiveAfterArchive,
  orderSessions,
  parseOrder,
  SESSION_ORDER_STORAGE_KEY,
} from "@/lib/chat/session-order";
import { withProfileBody, withProfileQuery } from "@/lib/chat/profile";
import { useSearchShortcut } from "@/lib/chat/search-shortcut";
import { fetchSessionList } from "@/lib/chat/session-list-fetch";
import { usePersistentState } from "@/lib/use-persistent-state";
import type {
  ChatMessage,
  SessionSummary,
  SessionTag,
  TagSuggestion,
} from "@/types";

export interface ChatPaneProps {
  initialSessions: SessionSummary[];
  initialSessionId: string | null;
  initialMessages: ChatMessage[];
  storageEnabled: boolean;
  /** The session's profile (FG-28) — its sessions, and its brain. Switching
   * is the header's profile switcher, which re-renders this page. */
  profile: string;
  /** Text the composer opens with (`?draft=`); never sent on its own. */
  initialDraft?: string;
  /** Send `initialDraft` as the first turn on arrival (the landing page's
   * composer already had the user press send). */
  autoSend?: boolean;
  /** Words to highlight on arrival (`?find=`): a message-search result opened
   * from another chat. */
  initialHighlight?: string;
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
  profile,
  initialDraft,
  autoSend = false,
  initialHighlight,
}: ChatPaneProps) {
  const router = useRouter();
  // Every client read below carries the selected profile, because a profile is
  // a whole HERMES_HOME: reading the default profile's sessions while the turn
  // runs in another is what files one profile's reply in another's history.
  const path = (p: string) => withProfileQuery(p, profile);
  const payload = <T extends object>(b: T) => withProfileBody(b, profile);
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  // The user's manual left-to-right ordering of the tabs, persisted per-device
  // as a JSON string (a stable snapshot for useSyncExternalStore). The array is
  // derived and applied to whatever the server most recently returned.
  const [orderRaw] = usePersistentState<string>(
    SESSION_ORDER_STORAGE_KEY,
    "",
    (raw) => raw,
    (value) => value,
  );
  const orderedSessions = useMemo(
    () => orderSessions(sessions, parseOrder(orderRaw)),
    [sessions, orderRaw],
  );
  const conv = useChatConversation({
    profile,
    initialSessionId,
    initialMessages,
    initialHighlight,
    initialDraft,
    autoSend,
    findSession: (id) => sessions.find((s) => s.id === id),
    onSessionsStale: () => void refreshSessions(),
  });
  const {
    sessionId,
    messages,
    inSearchOpen,
    setInSearchOpen,
    highlightTerm,
    setHighlightTerm,
    highlightCallbackRef,
    openConversation,
    startNewConversation,
  } = conv;
  const [detailsSession, setDetailsSession] = useState<SessionSummary | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set when the search shortcut opened the drawer, so it focuses its search.
  const [drawerFocusSearch, setDrawerFocusSearch] = useState(false);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerFocusSearch(false);
  }, [setDrawerOpen, setDrawerFocusSearch]);
  const t = useT("chatPage");
  // ── Tagging state ──
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [sessionTags, setSessionTags] = useState<SessionTag[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<TagSuggestion[]>([]);
  const [includeTags, setIncludeTags] = useState<string[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<"any" | "all">("any");

  // Profile, tag filters and searches live behind one toggle, collapsed by
  // default so the transcript gets the screen; remembered per browser.
  const [filtersOpen, setFiltersOpen] = usePersistentState<boolean>(
    CHAT_FILTERS_OPEN_STORAGE_KEY,
    false,
    parseFiltersOpen,
    serializeFiltersOpen,
  );

  // `/` or Ctrl/Cmd+K: focus the chats sidebar's search (titles + every
  // conversation's messages). Below `lg` the sidebar is hidden, so the focus
  // does not take and the Chats drawer opens with its search focused instead.
  const sidebarRef = useRef<HTMLElement | null>(null);
  useSearchShortcut(() => {
    const input = sidebarRef.current?.querySelector<HTMLInputElement>(
      '[data-component="SessionSearch"] input',
    );
    input?.focus();
    if (input && document.activeElement === input) {
      input.select();
      return;
    }
    setDrawerFocusSearch(true);
    setDrawerOpen(true);
  });

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

  // Register the chat header action callbacks (startNew / openArchived) into the
  // shared ref so the ChatHeaderActions component in the MobileShell header can
  // invoke them.  Runs on every render (no deps) so the ref always holds the
  // latest closures.  The cleanup resets to noops on unmount so a stale ref
  // can't fire after navigating away from the chat page.
  useEffect(() => {
    chatHeaderActionsRef.current.startNew = startNewConversation;
    chatHeaderActionsRef.current.openArchived = () => setArchivedOpen(true);
    chatHeaderActionsRef.current.openDetails = () => {
      const active = sessions.find((s) => s.id === sessionId);
      if (active) void onOpenDetails(active);
    };
  });
  useEffect(() => {
    return () => {
      chatHeaderActionsRef.current = {
        startNew: () => {},
        openArchived: () => {},
        openDetails: () => {},
      };
    };
  }, []);

  useEffect(() => {
    if (initialHighlight === undefined) return;
    // Drop `?find=` so a reload or shared link opens the chat without it.
    const url = new URL(window.location.href);
    url.searchParams.delete("find");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Search handlers ──────────────────────────────────────────────

  const crossSessionSearch = (q: string, signal: AbortSignal) =>
    chatsApi.searchMessages(q, signal, profile);

  function jumpToSearchResult(result: { session_id: string; snippet: string }) {
    const term = highlightTermOf(result.snippet);
    if (result.session_id !== sessionId) {
      // Another chat: navigate like a sidebar row, so the title, address and
      // Back all follow; the chat page re-opens with `?find=` highlighted.
      router.push(`${chatHref(result.session_id, profile)}&find=${encodeURIComponent(term)}`);
      return;
    }
    setHighlightTerm(term);
    setInSearchOpen(true);
  }

  return (
    <div data-component="ChatPane" className="flex min-h-0 flex-1 gap-6">
      <aside
        ref={sidebarRef}
        data-component="chat-sidebar"
        aria-label="Chats"
        className="hidden w-[288px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] pr-3 lg:flex lg:flex-col"
      >
        <ChatsSidebar
          profile={profile}
          activeSessionId={sessionId}
          initialSessions={sessions}
          categoryFilter
          searchShortcut="hint"
          messageSearch={crossSessionSearch}
          onOpenMessageHit={jumpToSearchResult}
        />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatFiltersPanel
        open={filtersOpen}
        onToggle={() => setFiltersOpen(!filtersOpen)}
        profile={profile}
        filterCount={includeTags.length + excludeTags.length}
        searchActive={inSearchOpen || highlightTerm !== undefined}
      >
      {/* Tag filter bar */}
      <TagFilterBar
        tags={allTags}
        includeTags={includeTags}
        excludeTags={excludeTags}
        matchMode={matchMode}
        onToggle={toggleTagFilter}
        onMatchModeChange={setMatchMode}
      />

      {/* In-conversation search toggle (all-sessions search lives in the chats sidebar / drawer). */}
      {sessionId && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1">
          <button
            type="button"
            onClick={() => {
              setInSearchOpen((v) => !v);
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
        </div>
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
      </ChatFiltersPanel>

      <ChatConversationView
        conv={conv}
        storageEnabled={storageEnabled}
        composerInitialText={autoSend ? undefined : initialDraft}
      />


      <div data-component="chat-dock" className="mt-2 flex gap-2 lg:hidden">
        <button
          type="button"
          data-action="open-chats"
          onClick={() => setDrawerOpen(true)}
          className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-medium text-[var(--color-fg)]"
        >
          <MessageIcon size={16} />
          <span className="truncate">{t("chats")}</span>
        </button>
        <button
          type="button"
          data-action="new-chat"
          onClick={startNewConversation}
          className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] text-sm font-medium text-[var(--color-accent-fg)]"
        >
          <PlusIcon size={16} />
          {t("newChat")}
        </button>
      </div>
      </div>
      <ChatsDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        focusSearch={drawerFocusSearch}
        profile={profile}
        activeSessionId={sessionId}
        initialSessions={sessions}
        categoryFilter
        messageSearch={crossSessionSearch}
        onOpenMessageHit={jumpToSearchResult}
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

    </div>
  );
}
