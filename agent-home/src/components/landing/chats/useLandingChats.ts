"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PinSuggestion, PinSuggestionsResponse } from "@/types/landing";

import { onSessionsChanged } from "@/lib/chat/sessions-changed";

import { chatsApi } from "./chatsApi";
import {
  USER_CHAT_SOURCE,
  isPinned,
  isUserStartedChat,
  pinsSupported,
  splitSessions,
  type LandingSession,
} from "./model";

/** Untitled chats get their agent title a few seconds after the first reply. */
export const TITLE_POLL_MS = 10_000;
const TITLE_POLL_MAX = 12;
const SUGGESTION_RETRY_MS = 5_000;
const SUGGESTION_RETRIES = 3;
/** How long a just-started chat stays listed while the server catches up. */
export const PENDING_CHAT_MS = 60_000;

/** `pending` lands in the contract with the pins workstream (B2). */
type PendingSuggestions = PinSuggestionsResponse & { pending?: boolean };

export interface LandingChats {
  sessions: LandingSession[];
  pinned: LandingSession[];
  recent: LandingSession[];
  /** First load still in flight (no data yet). */
  loading: boolean;
  /** The list could not be read and nothing was cached. */
  failed: boolean;
  /** Pin UI is shown only once the pins workstream is deployed. */
  canPin: boolean;
  suggestions: PinSuggestion[];
  /** Aquarium chats the server listed but `userChatsOnly` hides (e.g. report topics). */
  hiddenIds: ReadonlySet<string>;
  /** Session ids with a write in flight (pin, rename or archive). */
  busyIds: ReadonlySet<string>;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  /** Resolves true once the server saved the new pin state. */
  togglePin: (session: LandingSession) => Promise<boolean>;
  rename: (session: LandingSession, title: string) => Promise<boolean>;
  /** Hides the chat at once; restores it if the server refuses. Resolves true once saved. */
  setArchived: (session: LandingSession, archived: boolean) => Promise<boolean>;
  acceptSuggestions: (ids: string[]) => Promise<void>;
  dismissSuggestions: (ids: string[]) => Promise<void>;
}

/**
 * Sessions, pins, pin suggestions and inline rename for one profile's
 * conversation list. Every write is locked per session (a double-click never
 * sends twice) and reconciles with a forced re-read of the list.
 *
 * `userChatsOnly` lists just the chats the user started by typing: the server
 * returns `agent_home` sessions only, and `isUserStartedChat` drops the rest.
 * Hidden pins stay pinned; they are simply not listed.
 */
export function useLandingChats({
  profile,
  initialSessions,
  fetchImpl = fetch,
  userChatsOnly = false,
}: {
  profile?: string;
  initialSessions?: LandingSession[];
  fetchImpl?: typeof fetch;
  userChatsOnly?: boolean;
}): LandingChats {
  const keep = useCallback(
    (list: LandingSession[]) => (userChatsOnly ? list.filter(isUserStartedChat) : list),
    [userChatsOnly],
  );
  const [sessions, setSessions] = useState<LandingSession[] | null>(
    initialSessions ? keep(initialSessions) : null,
  );
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [pinsGone, setPinsGone] = useState(false);
  const [suggestions, setSuggestions] = useState<PinSuggestion[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const locks = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Chats started on this page that the list may not include yet. */
  const pendingChats = useRef(new Map<string, { session: LandingSession; until: number }>());

  const apply = useCallback((all: LandingSession[] | null) => {
    if (!alive.current) return;
    if (all) {
      const next = keep(all);
      if (userChatsOnly) {
        const shown = new Set(next.map((s) => s.id));
        setHiddenIds(new Set(all.filter((s) => !shown.has(s.id)).map((s) => s.id)));
      }
      const listed = new Set(next.map((s) => s.id));
      const extra: LandingSession[] = [];
      for (const [id, p] of pendingChats.current) {
        if (listed.has(id) || p.until < Date.now()) pendingChats.current.delete(id);
        else extra.push(p.session);
      }
      setSessions(extra.length ? [...extra, ...next] : next);
      setFailed(false);
    } else {
      setSessions((prev) => {
        if (prev === null) setFailed(true);
        return prev;
      });
    }
  }, [keep, userChatsOnly]);

  const source = userChatsOnly ? USER_CHAT_SOURCE : undefined;
  const refresh = useCallback(
    (force = true) => chatsApi.sessions(profile, { force, source }).then(apply),
    [profile, source, apply],
  );

  useEffect(() => {
    let cancelled = false;
    void chatsApi.sessions(profile, { source }).then((next) => {
      if (!cancelled) apply(next);
    });
    let retry: number | undefined;
    let tries = 0;
    const loadSuggestions = () =>
      void chatsApi.pinSuggestions(profile).then((res) => {
        if (cancelled || !res) return;
        if (res.items) setSuggestions(res.items);
        // The review runs in the background; re-read a few times while it does.
        if ((res as PendingSuggestions).pending && tries++ < SUGGESTION_RETRIES) {
          retry = window.setTimeout(loadSuggestions, SUGGESTION_RETRY_MS);
        }
      });
    loadSuggestions();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [profile, source, apply]);

  useEffect(
    () =>
      onSessionsChanged((detail) => {
        if (detail.profile && profile && detail.profile !== profile) return;
        const started = detail.session;
        if (started) {
          const at = Date.now() / 1000;
          setSessions((prev) => {
            const list = prev ?? [];
            if (list.some((s) => s.id === started.id)) {
              return list.map((s) =>
                s.id === started.id ? { ...s, last_active: at, is_active: true } : s,
              );
            }
            const session: LandingSession = {
              id: started.id,
              source: USER_CHAT_SOURCE,
              title: null,
              preview: started.preview ?? null,
              message_count: 1,
              started_at: at,
              last_active: at,
              ended_at: null,
              is_active: true,
              ...(pinsSupported(list) ? { pinned_at: null } : {}),
            };
            pendingChats.current.set(started.id, { session, until: Date.now() + PENDING_CHAT_MS });
            return [session, ...list];
          });
        }
        void refresh();
      }),
    [profile, refresh],
  );

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const waitingForTitle = (sessions ?? []).some(
    (s) => !s.title && s.message_count > 0 && !s.archived,
  );
  const polls = useRef(0);
  useEffect(() => {
    if (!waitingForTitle) {
      polls.current = 0;
      return;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      polls.current += 1;
      if (polls.current > TITLE_POLL_MAX) {
        window.clearInterval(id);
        return;
      }
      void refresh(false);
    }, TITLE_POLL_MS);
    return () => window.clearInterval(id);
  }, [waitingForTitle, refresh]);

  const withLock = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setBusy(new Set(locks.current));
    try {
      await fn();
    } finally {
      locks.current.delete(key);
      if (alive.current) setBusy(new Set(locks.current));
    }
  }, []);

  const patch = useCallback((id: string, change: Partial<LandingSession>) => {
    setSessions((prev) => prev?.map((s) => (s.id === id ? { ...s, ...change } : s)) ?? prev);
  }, []);

  const setPinned = useCallback(
    async (id: string, pinned: boolean, before: number | null | undefined) => {
      patch(id, { pinned_at: pinned ? Date.now() / 1000 : null });
      const res = await chatsApi.setPinned(id, pinned, profile, fetchImpl);
      if (!alive.current) return false;
      if (res.ok) {
        if (res.data && "pinned_at" in res.data) patch(id, { pinned_at: res.data.pinned_at });
        return true;
      }
      patch(id, { pinned_at: before });
      if (res.unsupported) setPinsGone(true);
      else setError(res.error);
      return false;
    },
    [fetchImpl, patch, profile],
  );

  const togglePin = useCallback(
    async (s: LandingSession) => {
      let ok = false;
      await withLock(s.id, async () => {
        if (await setPinned(s.id, !isPinned(s), s.pinned_at)) {
          ok = true;
          setSuggestions((prev) => prev.filter((x) => x.session_id !== s.id));
          void refresh();
        }
      });
      return ok;
    },
    [refresh, setPinned, withLock],
  );

  const rename = useCallback(
    async (s: LandingSession, title: string) => {
      const next = title.trim();
      if (next === (s.title ?? "").trim()) return true;
      let ok = false;
      await withLock(s.id, async () => {
        const res = await chatsApi.rename(s.id, next, profile, fetchImpl);
        if (!alive.current) return;
        if (res.ok) {
          patch(s.id, { title: (res.data?.title ?? next) || null });
          ok = true;
          void refresh();
        } else {
          setError(res.error);
        }
      });
      return ok;
    },
    [fetchImpl, patch, profile, refresh, withLock],
  );

  const setArchived = useCallback(
    async (s: LandingSession, archived: boolean) => {
      let ok = false;
      await withLock(s.id, async () => {
        patch(s.id, { archived });
        const res = await chatsApi.archive(s.id, archived, profile, fetchImpl);
        if (!alive.current) return;
        if (res.ok) {
          ok = true;
          if (archived) setSuggestions((prev) => prev.filter((x) => x.session_id !== s.id));
          void refresh();
        } else {
          patch(s.id, { archived: s.archived ?? false });
          setError(res.error);
        }
      });
      return ok;
    },
    [fetchImpl, patch, profile, refresh, withLock],
  );

  const acceptSuggestions = useCallback(
    (ids: string[]) =>
      withLock("suggestions", async () => {
        const current = new Map((sessions ?? []).map((s) => [s.id, s.pinned_at]));
        for (const id of ids) {
          if (!(await setPinned(id, true, current.get(id)))) return;
        }
        setSuggestions((prev) => prev.filter((x) => !ids.includes(x.session_id)));
        void refresh();
      }),
    [refresh, sessions, setPinned, withLock],
  );

  const dismissSuggestions = useCallback(
    (ids: string[]) =>
      withLock("suggestions", async () => {
        // Hidden right away: "Not now" must never nag, even if the route is down.
        setSuggestions((prev) => prev.filter((x) => !ids.includes(x.session_id)));
        await chatsApi.dismissSuggestions(ids, profile, fetchImpl);
      }),
    [fetchImpl, profile, withLock],
  );

  const list = useMemo(() => sessions ?? [], [sessions]);
  const { pinned, recent } = useMemo(() => splitSessions(list), [list]);
  const canPin = !pinsGone && pinsSupported(list);
  const visibleSuggestions = useMemo(() => {
    if (!canPin) return [];
    const byId = new Map(list.map((s) => [s.id, s]));
    return suggestions.filter((x) => {
      const s = byId.get(x.session_id);
      return s ? !isPinned(s) && !s.archived : false;
    });
  }, [canPin, list, suggestions]);

  return {
    sessions: list,
    pinned: canPin ? pinned : [],
    recent: canPin ? recent : splitSessions(list.map((s) => ({ ...s, pinned_at: null }))).recent,
    loading: sessions === null && !failed,
    failed,
    canPin,
    suggestions: visibleSuggestions,
    hiddenIds,
    busyIds: busy,
    error,
    clearError: () => setError(null),
    refresh: () => refresh(true),
    togglePin,
    rename,
    setArchived,
    acceptSuggestions,
    dismissSuggestions,
  };
}
