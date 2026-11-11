"use client";

/**
 * Browser side of the landing Incomings tab (plan A.1): the flagged-arrivals
 * list, its badge count, and the Done / Dismiss / Reopen write.
 *
 * Every BFF route is profile-scoped by the session (`apiClientForRequest()`),
 * so the hooks only need the profile as a key: switching profile drops the
 * old profile's data instead of showing it under the new one.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  IncomingAttentionAction,
  IncomingDetail,
  IncomingItem,
  IncomingsAttentionCount,
  IncomingsFacets,
  IncomingsResponse,
} from "@/types";

export const INCOMINGS_POLL_MS = 15_000;
export const INCOMINGS_LIST_LIMIT = 50;

/** Fired after any attention write so every count/list on the page refetches. */
export const INCOMINGS_CHANGED_EVENT = "incomings:changed";

export type IncomingsFilter = "all" | "messages" | "email" | "calendar";

export type WriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

/** The i18n key (`incomings` namespace) for a failed attention write. */
export function attentionErrorKey(res: { status?: number }): string {
  // Upstream answers 403 when the caller can see the arrival but doesn't own it.
  return res.status === 403 ? "errors.notOwner" : "errors.write";
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store", method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => null)) as (T & { detail?: string }) | null;
    if (!res.ok) {
      return {
        ok: false,
        error: (data && typeof data.detail === "string" && data.detail) || "",
        status: res.status,
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "" };
  }
}

function itemPath(id: string): string {
  return `/api/incomings/${encodeURIComponent(id)}`;
}

export const incomingsApi = {
  list: () =>
    getJson<IncomingsResponse>(`/api/incomings?attention=open&limit=${INCOMINGS_LIST_LIMIT}`),
  count: () => getJson<IncomingsAttentionCount>("/api/incomings/attention-count"),
  facets: () => getJson<IncomingsFacets>("/api/incomings/facets"),
  detail: (id: string) => getJson<IncomingDetail>(itemPath(id)),
  setAttention: (id: string, body: IncomingAttentionAction) =>
    postJson<IncomingItem>(`${itemPath(id)}/attention`, body),
  remember: (id: string) => postJson<IncomingItem>(`${itemPath(id)}/remember`, {}),
  createTodo: (item: IncomingItem, title: string) =>
    postJson<{ id: string; ref?: string | null }>("/api/todos", {
      title,
      description: incomingSummary(item),
      source_kind: "inbound",
      source_ref: item.id,
    }),
};

function announceChange(): void {
  window.dispatchEvent(new Event(INCOMINGS_CHANGED_EVENT));
}

// ── Item helpers ───────────────────────────────────────────────────────────

/** Flagged and not yet handled (the rule the server applies for `attention=open`). */
export function isOpenAttention(item: IncomingItem): boolean {
  return Boolean(item.attention_at) && !item.attention_cleared_at;
}

/** Urgent = escalated at high/urgent priority, or a critical calendar event. */
export function isUrgent(item: IncomingItem): boolean {
  if (item.attention_reason === "critical_event") return true;
  return (
    item.attention_reason === "escalated" &&
    (item.attention_priority === "urgent" || item.attention_priority === "high")
  );
}

/** Which filter chip a surface belongs to. */
export function surfaceGroup(surface: string): Exclude<IncomingsFilter, "all"> {
  if (surface === "email") return "email";
  if (surface === "calendar") return "calendar";
  return "messages";
}

export function incomingTitle(item: IncomingItem): string {
  return item.subject?.trim() || item.sender_name?.trim() || item.sender_id?.trim() || "";
}

export function incomingSender(item: IncomingItem): string {
  return item.sender_name?.trim() || item.sender_id?.trim() || item.conversation_name?.trim() || "";
}

/** One line for a prompt or a to-do: `M512 (email from Alice, "Q3 invoice")`. */
export function incomingSummary(item: IncomingItem): string {
  const who = incomingSender(item);
  const subject = item.subject?.trim();
  const parts = [item.surface, who ? `from ${who}` : ""].filter(Boolean).join(" ");
  const label = subject ? `${parts}, "${subject}"` : parts;
  return `${item.ref || item.id} (${label})`;
}

/** The hand-off prompt for "Ask in chat" / "Reply with AI". */
export function incomingPrompt(item: IncomingItem, ask: "reply" | "ask"): string {
  const body = (item.body || "").replace(/\s+/g, " ").trim();
  const quoted = body ? `\n\n> ${body.length > 600 ? `${body.slice(0, 599)}…` : body}` : "";
  const request =
    ask === "reply"
      ? "Help me write a reply to it."
      : "What does it need from me, and what should I do next?";
  return `About ${incomingSummary(item)}: ${request}${quoted}`;
}

// ── Count hook ─────────────────────────────────────────────────────────────

export interface UseIncomingsAttention {
  /** Null until the first good read (or while the route is unavailable). */
  count: number | null;
  urgent: number;
  bySurface: Record<string, number>;
  /** The latest read failed; the count shown is the last good one. */
  stale: boolean;
  refresh: () => Promise<void>;
}

/**
 * The Incomings badge: polls `attention-count` every 15s while the tab is
 * visible, refetches on focus and after any attention write, keeps the last
 * good value when a read fails, and starts over when `profile` changes.
 */
export function useIncomingsAttention(profile: string): UseIncomingsAttention {
  const [state, setState] = useState<{ profile: string; data: IncomingsAttentionCount | null }>({
    profile,
    data: null,
  });
  const [stale, setStale] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const profileRef = useRef(profile);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const forProfile = profileRef.current;
    const run = (async () => {
      const next = await incomingsApi.count();
      if (profileRef.current !== forProfile) return;
      if (!next || typeof next.count !== "number") {
        setStale(true);
        return;
      }
      setStale(false);
      setState({ profile: forProfile, data: next });
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    let alive = true;
    const visible = () => document.visibilityState === "visible";
    profileRef.current = profile;
    inFlight.current = null;
    void refresh();
    const timer = window.setInterval(() => {
      if (alive && visible()) void refresh();
    }, INCOMINGS_POLL_MS);
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (visible()) void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(INCOMINGS_CHANGED_EVENT, onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(INCOMINGS_CHANGED_EVENT, onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [profile, refresh]);

  const data = state.profile === profile ? state.data : null;
  return {
    count: data ? Math.min(99, Math.max(0, data.count)) : null,
    urgent: data?.urgent ?? 0,
    bySurface: data?.by_surface ?? {},
    stale,
    refresh,
  };
}

// ── List hook ──────────────────────────────────────────────────────────────

export interface UseIncomings {
  items: IncomingItem[];
  loading: boolean;
  /** The first read failed (no data to show). */
  failed: boolean;
  /** No surface ever sent an arrival to this profile (from the facets). */
  noSources: boolean;
  refresh: () => Promise<void>;
  /**
   * Done / Dismiss: removes the row at once, then writes. Resolves with the
   * item on success (for Undo) or an error message after restoring the row.
   */
  clear: (item: IncomingItem, outcome?: "done" | "dismissed") => Promise<WriteResult<IncomingItem>>;
  /** Undo of `clear`: reopens upstream and puts the row back. */
  reopen: (item: IncomingItem) => Promise<WriteResult<IncomingItem>>;
}

type ListState = {
  profile: string;
  items: IncomingItem[] | null;
  failed: boolean;
  noSources: boolean;
};

const withoutItem = (id: string) => (s: ListState): ListState => ({
  ...s,
  items: (s.items ?? []).filter((i) => i.id !== id),
});

/** Puts a row back in newest-first order (Undo, or a failed write). */
const withItem = (item: IncomingItem) => (s: ListState): ListState => ({
  ...s,
  items: [...(s.items ?? []).filter((i) => i.id !== item.id), item].sort((a, b) =>
    (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""),
  ),
});

/**
 * The open flagged arrivals for the Incomings tab. Reads only while
 * `enabled` (the tab or a detail is showing), refetches after any attention
 * write elsewhere on the page, and resets when `profile` changes.
 */
export function useIncomings({ profile, enabled }: { profile: string; enabled: boolean }): UseIncomings {
  const [state, setState] = useState<ListState>({ profile, items: null, failed: false, noSources: false });
  const profileRef = useRef(profile);

  const refresh = useCallback(async () => {
    const forProfile = profileRef.current;
    const page = await incomingsApi.list();
    if (profileRef.current !== forProfile) return;
    if (!page || !Array.isArray(page.items)) {
      setState((s) =>
        s.profile === forProfile
          ? { ...s, failed: true }
          : { profile: forProfile, items: null, failed: true, noSources: false },
      );
      return;
    }
    // A backend without the attention columns ignores `attention=open`;
    // filtering here keeps such a box from listing every arrival.
    const items = page.items.filter(isOpenAttention);
    let noSources = false;
    if (items.length === 0) {
      const facets = await incomingsApi.facets();
      if (profileRef.current !== forProfile) return;
      noSources = Boolean(facets) && (facets?.surfaces ?? []).length === 0;
    }
    setState({ profile: forProfile, items, failed: false, noSources });
  }, []);

  useEffect(() => {
    profileRef.current = profile;
    if (!enabled) return;
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(INCOMINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INCOMINGS_CHANGED_EVENT, onChanged);
  }, [enabled, profile, refresh]);

  const current = state.profile === profile ? state : null;
  const items = current?.items ?? null;

  const clear = useCallback(
    async (item: IncomingItem, outcome: "done" | "dismissed" = "done") => {
      setState(withoutItem(item.id));
      const res = await incomingsApi.setAttention(item.id, { action: "clear", outcome });
      if (!res.ok) {
        setState(withItem(item));
        return res;
      }
      announceChange();
      return res;
    },
    [],
  );

  const reopen = useCallback(async (item: IncomingItem) => {
    const res = await incomingsApi.setAttention(item.id, { action: "reopen" });
    if (res.ok) {
      setState(withItem({ ...item, ...res.data, attention_cleared_at: null }));
      announceChange();
    }
    return res;
  }, []);

  return {
    items: items ?? [],
    loading: enabled && items === null && !current?.failed,
    failed: Boolean(current?.failed) && items === null,
    noSources: Boolean(current?.noSources),
    refresh,
    clear,
    reopen,
  };
}

/** Write-through helper for surfaces without the list hook (the detail page). */
export async function setIncomingAttention(
  id: string,
  body: IncomingAttentionAction,
): Promise<WriteResult<IncomingItem>> {
  const res = await incomingsApi.setAttention(id, body);
  if (res.ok) announceChange();
  return res;
}
