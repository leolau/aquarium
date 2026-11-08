"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PinSuggestion, PinSuggestionsResponse } from "@/types/landing";

import { chatsApi } from "./chatsApi";
import { isPinned, pinsSupported, splitSessions, type LandingSession } from "./model";

/** Untitled chats get their agent title a few seconds after the first reply. */
export const TITLE_POLL_MS = 10_000;
const TITLE_POLL_MAX = 12;
const SUGGESTION_RETRY_MS = 5_000;
const SUGGESTION_RETRIES = 3;

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
  /** Session ids with a write in flight (pin or rename). */
  busyIds: ReadonlySet<string>;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  /** Resolves true once the server saved the new pin state. */
  togglePin: (session: LandingSession) => Promise<boolean>;
  rename: (session: LandingSession, title: string) => Promise<boolean>;
  acceptSuggestions: (ids: string[]) => Promise<void>;
  dismissSuggestions: (ids: string[]) => Promise<void>;
}

/**
 * Sessions, pins, pin suggestions and inline rename for one profile's
 * conversation list. Every write is locked per session (a double-click never
 * sends twice) and reconciles with a forced re-read of the list.
 */
export function useLandingChats({
  profile,
  initialSessions,
  fetchImpl = fetch,
}: {
  profile?: string;
  initialSessions?: LandingSession[];
  fetchImpl?: typeof fetch;
}): LandingChats {
  const [sessions, setSessions] = useState<LandingSession[] | null>(initialSessions ?? null);
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

  const apply = useCallback((next: LandingSession[] | null) => {
    if (!alive.current) return;
    if (next) {
      setSessions(next);
      setFailed(false);
    } else {
      setSessions((prev) => {
        if (prev === null) setFailed(true);
        return prev;
      });
    }
  }, []);

  const refresh = useCallback(
    (force = true) => chatsApi.sessions(profile, { force }).then(apply),
    [profile, apply],
  );

  useEffect(() => {
    let cancelled = false;
    void chatsApi.sessions(profile).then((next) => {
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
  }, [profile, apply]);

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
    busyIds: busy,
    error,
    clearError: () => setError(null),
    refresh: () => refresh(true),
    togglePin,
    rename,
    acceptSuggestions,
    dismissSuggestions,
  };
}
