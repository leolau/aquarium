"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useProjectAction } from "@/components/projects/useProjectAction";
import { withProfileBody, withProfileQuery } from "@/lib/chat/profile";
import type { SessionSummary } from "@/types";
import type { RenameSessionResponse, SessionTitleResponse } from "@/types/landing";

/**
 * Conversation titles on the landing page and chat strip.
 *
 * The backend auto-titles an untitled agent-home chat once, a few seconds
 * after its first reply (a separate auxiliary call; it never overwrites a
 * title that is already set). Nothing pushes that title to the browser, so a
 * client that just finished a first turn polls this one cheap read a few
 * times. A rename by the person always wins: the server never replaces a set
 * title, and this hook stops watching once the person has renamed.
 */

export const SESSION_TITLE_ROUTE = "/api/chat/sessions/rename";

/** Waits between title reads after a first turn (about 4 s, 10 s, 20 s in). */
export const AUTO_TITLE_DELAYS_MS: readonly number[] = [4_000, 6_000, 10_000];

/** What a session row shows: its title, else its first-message preview. */
export function sessionLabel(
  s: Pick<SessionSummary, "title" | "preview">,
  fallback = "New chat",
): string {
  return s.title?.trim() || s.preview?.trim() || fallback;
}

/**
 * Whether a finished turn may have produced an auto-title worth waiting for:
 * the session is still untitled and young (the backend only titles during the
 * first two exchanges, i.e. at most four visible messages).
 */
export function mayGetAutoTitle(
  s: Pick<SessionSummary, "title" | "message_count"> | null | undefined,
): boolean {
  if (!s) return true;
  if (s.title && s.title.trim()) return false;
  return (s.message_count ?? 0) <= 4;
}

/** One conversation's current title; `undefined` when the read failed. */
export async function fetchSessionTitle(
  sessionId: string,
  profile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null | undefined> {
  const url = withProfileQuery(
    `${SESSION_TITLE_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`,
    profile,
  );
  try {
    const res = await fetchImpl(url, { cache: "no-store", method: "GET" });
    if (!res.ok) return undefined;
    const body = (await res.json()) as SessionTitleResponse;
    return body?.title?.trim() || null;
  } catch {
    return undefined;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface WaitForAutoTitleOptions {
  profile?: string;
  delaysMs?: readonly number[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Poll for the auto-title after a first turn. Resolves the title once one
 * appears, or `null` after the last attempt or when aborted.
 */
export async function waitForAutoTitle(
  sessionId: string,
  opts: WaitForAutoTitleOptions = {},
): Promise<string | null> {
  const delays = opts.delaysMs ?? AUTO_TITLE_DELAYS_MS;
  const sleep = opts.sleep ?? abortableSleep;
  for (const ms of delays) {
    await sleep(ms, opts.signal);
    if (opts.signal?.aborted) return null;
    const title = await fetchSessionTitle(sessionId, opts.profile, opts.fetchImpl);
    if (opts.signal?.aborted) return null;
    if (title) return title;
  }
  return null;
}

export interface UseSessionTitleOptions {
  sessionId: string | null;
  profile?: string;
  /** The title from the latest session list read (null when untitled). */
  title: string | null;
  /** Called when an auto-title or rename lands, e.g. to patch a list row. */
  onTitle?: (title: string | null, source: "agent" | "user") => void;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  delaysMs?: readonly number[];
}

export interface SessionTitleState {
  title: string | null;
  /** Rename in place; an empty string clears the title. */
  rename: (next: string) => Promise<boolean>;
  /** Start polling for the auto-title (call after a turn completes). */
  watchForAutoTitle: () => void;
  renaming: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * A conversation's title, kept current across the auto-title and renames.
 * Writes go through `useProjectAction` (click lock + Idempotency-Key).
 */
export function useSessionTitle(opts: UseSessionTitleOptions): SessionTitleState {
  const { sessionId, profile, onTitle, fetchImpl, delaysMs } = opts;
  const [title, setTitle] = useState<string | null>(opts.title);
  // Follow the server's value whenever the list read hands down a new one or
  // the hook is pointed at another session.
  const [seen, setSeen] = useState({ sessionId, title: opts.title });
  if (seen.sessionId !== sessionId || seen.title !== opts.title) {
    setSeen({ sessionId, title: opts.title });
    setTitle(opts.title);
  }

  const action = useProjectAction<RenameSessionResponse>(fetchImpl);
  const userSet = useRef(false);
  const watcher = useRef<AbortController | null>(null);
  const titleRef = useRef(title);
  const onTitleRef = useRef(onTitle);
  useEffect(() => {
    titleRef.current = title;
    onTitleRef.current = onTitle;
  });

  useEffect(() => {
    userSet.current = false;
    return () => {
      watcher.current?.abort();
      watcher.current = null;
    };
  }, [sessionId]);

  const watchForAutoTitle = useCallback(() => {
    if (!sessionId || userSet.current || titleRef.current) return;
    if (watcher.current) return;
    const controller = new AbortController();
    watcher.current = controller;
    void waitForAutoTitle(sessionId, {
      profile,
      delaysMs,
      fetchImpl,
      signal: controller.signal,
    }).then((auto) => {
      if (watcher.current === controller) watcher.current = null;
      if (!auto || controller.signal.aborted || userSet.current || titleRef.current) return;
      setTitle(auto);
      onTitleRef.current?.(auto, "agent");
    });
  }, [sessionId, profile, delaysMs, fetchImpl]);

  const { run } = action;
  const rename = useCallback(
    async (next: string) => {
      if (!sessionId) return false;
      const result = await run(SESSION_TITLE_ROUTE, {
        method: "PATCH",
        body: withProfileBody({ sessionId, title: next.trim() }, profile),
        skipRefresh: true,
        onSuccess: (data) => {
          userSet.current = true;
          watcher.current?.abort();
          watcher.current = null;
          const landed = data?.title?.trim() || null;
          setTitle(landed);
          onTitleRef.current?.(landed, "user");
        },
      });
      return Boolean(result?.ok);
    },
    [run, sessionId, profile],
  );

  return {
    title,
    rename,
    watchForAutoTitle,
    renaming: action.busy,
    error: action.error,
    clearError: action.clearError,
  };
}
