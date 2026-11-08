"use client";

/**
 * Session pins for the landing page: an optimistic overlay on the server's
 * `pinned_at`, plus the agent's pin suggestions.
 *
 * Writes follow `components/projects/useProjectAction.ts`: a synchronous
 * per-session lock (a ref, so two clicks in one frame cannot both fire),
 * an `Idempotency-Key` on every attempt and the *same* key on `retry()`.
 * The pin flips the moment it is clicked and rolls back if the server says
 * no (e.g. the 20-pin cap).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { newIdempotencyKey, sendProjectAction } from "@/components/projects/useProjectAction";
import { withProfileBody } from "@/lib/chat/profile";
import { LANDING_ROUTES, landingApi } from "@/lib/landing/api";
import type { SessionSummary } from "@/types";
import type { PinResponse, PinSuggestion } from "@/types/landing";

export interface TogglePinOptions {
  profile?: string;
  /** Re-use a key to replay a failed attempt; a fresh one otherwise. */
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

export interface TogglePinResult {
  ok: boolean;
  pinnedAt: number | null;
  error: string | null;
}

/** The DOM-free write: pin (`pinned: true`) or unpin one chat. */
export async function togglePin(
  sessionId: string,
  pinned: boolean,
  opts: TogglePinOptions = {},
): Promise<TogglePinResult> {
  const result = await sendProjectAction<PinResponse>(
    LANDING_ROUTES.pin,
    opts.idempotencyKey ?? newIdempotencyKey(),
    { method: "POST", body: withProfileBody({ sessionId, pinned }, opts.profile) },
    opts.fetchImpl ?? fetch,
  );
  if (!result.ok) return { ok: false, pinnedAt: null, error: result.error };
  return { ok: true, pinnedAt: result.data?.pinned_at ?? null, error: null };
}

/** `sessions` with the overlay applied (same order). */
export function applyPinOverrides(
  sessions: SessionSummary[],
  overrides: ReadonlyMap<string, number | null>,
): SessionSummary[] {
  if (overrides.size === 0) return sessions;
  return sessions.map((s) =>
    overrides.has(s.id) ? { ...s, pinned_at: overrides.get(s.id) ?? null } : s,
  );
}

/** The pinned chats, most recently pinned first. */
export function pinnedFirst(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((s) => s.pinned_at != null)
    .sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));
}

export interface UsePinsOptions {
  profile?: string;
  fetchImpl?: typeof fetch;
  /** Called after a confirmed change, e.g. to re-read the sessions list. */
  onChange?: (sessionId: string, pinnedAt: number | null) => void;
}

export interface PinsState {
  /** `sessions` with optimistic pins applied. */
  sessions: SessionSummary[];
  /** Those of them that are pinned, most recently pinned first. */
  pinned: SessionSummary[];
  isPinned: (sessionId: string) => boolean;
  /** Flip one chat. Resolves `null` when ignored (that chat is in flight). */
  togglePin: (sessionId: string, pinned?: boolean) => Promise<TogglePinResult | null>;
  /** Re-send the last failed toggle with the same idempotency key. */
  retry: () => Promise<TogglePinResult | null>;
  busy: (sessionId: string) => boolean;
  error: string | null;
  clearError: () => void;
}

export function usePins(sessions: SessionSummary[], opts: UsePinsOptions = {}): PinsState {
  const { profile, fetchImpl, onChange } = opts;
  const [overrides, setOverrides] = useState<Map<string, number | null>>(() => new Map());
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const locks = useRef(new Set<string>());
  const lastFailed = useRef<{ id: string; pinned: boolean; key: string } | null>(null);

  const view = useMemo(() => applyPinOverrides(sessions, overrides), [sessions, overrides]);

  // A fresh server list that agrees with an override makes it redundant.
  useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const s of sessions) {
        if (next.has(s.id) && !locks.current.has(s.id)) {
          if ((s.pinned_at != null) === (next.get(s.id) != null)) {
            next.delete(s.id);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const setOverride = (id: string, value: number | null | undefined) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      if (value === undefined) next.delete(id);
      else next.set(id, value);
      return next;
    });

  const exec = useCallback(
    async (id: string, pinned: boolean, key: string): Promise<TogglePinResult | null> => {
      if (locks.current.has(id)) return null;
      locks.current.add(id);
      setInflight(new Set(locks.current));
      setError(null);
      const previous = overrides.has(id) ? overrides.get(id) : undefined;
      setOverride(id, pinned ? Date.now() / 1000 : null);
      try {
        const result = await togglePin(id, pinned, { profile, idempotencyKey: key, fetchImpl });
        if (!result.ok) {
          setOverride(id, previous);
          lastFailed.current = { id, pinned, key };
          setError(result.error);
          return result;
        }
        lastFailed.current = null;
        setOverride(id, result.pinnedAt);
        onChange?.(id, result.pinnedAt);
        return result;
      } finally {
        locks.current.delete(id);
        setInflight(new Set(locks.current));
      }
    },
    [overrides, profile, fetchImpl, onChange],
  );

  const toggle = useCallback(
    (id: string, pinned?: boolean) => {
      const current = view.find((s) => s.id === id)?.pinned_at != null;
      return exec(id, pinned ?? !current, newIdempotencyKey());
    },
    [exec, view],
  );

  const retry = useCallback(async () => {
    const prev = lastFailed.current;
    return prev ? exec(prev.id, prev.pinned, prev.key) : null;
  }, [exec]);

  return {
    sessions: view,
    pinned: useMemo(() => pinnedFirst(view), [view]),
    isPinned: (id) => view.find((s) => s.id === id)?.pinned_at != null,
    togglePin: toggle,
    retry,
    busy: (id) => inflight.has(id),
    error,
    clearError: () => setError(null),
  };
}

export interface UsePinSuggestionsOptions {
  profile?: string;
  fetchImpl?: typeof fetch;
  /** Re-reads while the server reports a review in progress. */
  pendingRetryMs?: number;
}

export interface PinSuggestionsState {
  items: PinSuggestion[];
  loading: boolean;
  /** Hide suggestions for good; rolls back if the server refuses. */
  dismiss: (sessionIds: string[]) => Promise<boolean>;
  /** Drop one from the list locally (e.g. after it was pinned). */
  remove: (sessionId: string) => void;
  error: string | null;
}

/** The agent's "worth pinning" review, read once per profile on mount. */
export function usePinSuggestions(opts: UsePinSuggestionsOptions = {}): PinSuggestionsState {
  const { profile, fetchImpl, pendingRetryMs = 4000 } = opts;
  const [items, setItems] = useState<PinSuggestion[]>([]);
  // The profile whose first read has landed; anything else is still loading.
  const [loadedFor, setLoadedFor] = useState<{ profile?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      const res = await landingApi.pinSuggestions(profile);
      if (cancelled) return;
      if (res) setItems(res.items);
      setLoadedFor({ profile });
      if (res?.pending && attempts < 3) {
        attempts += 1;
        timer = setTimeout(load, pendingRetryMs);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [profile, pendingRetryMs]);

  const dismiss = useCallback(
    async (sessionIds: string[]) => {
      if (lock.current || sessionIds.length === 0) return false;
      lock.current = true;
      const removed = items.filter((i) => sessionIds.includes(i.session_id));
      setItems((prev) => prev.filter((i) => !sessionIds.includes(i.session_id)));
      setError(null);
      try {
        const result = await sendProjectAction(
          LANDING_ROUTES.dismissPinSuggestions,
          newIdempotencyKey(),
          { method: "POST", body: withProfileBody({ sessionIds }, profile) },
          fetchImpl ?? fetch,
        );
        if (!result.ok) {
          setItems((prev) => [
            ...removed.filter((r) => !prev.some((p) => p.session_id === r.session_id)),
            ...prev,
          ]);
          setError(result.error);
        }
        return result.ok;
      } finally {
        lock.current = false;
      }
    },
    [items, profile, fetchImpl],
  );

  const remove = useCallback((sessionId: string) => {
    setItems((prev) => prev.filter((i) => i.session_id !== sessionId));
  }, []);

  const loading = loadedFor === null || loadedFor.profile !== profile;
  return { items, loading, dismiss, remove, error };
}
