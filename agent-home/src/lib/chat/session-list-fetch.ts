/**
 * Coalescing fetch for the session list (`GET /api/chat/sessions`).
 *
 * Several components refresh the same endpoint independently: the Coral
 * unread badge polls every 45 s *and* fires on `focus` + `visibilitychange`
 * (both fire together on every tab resume), while ChatPane refetches after
 * every mutation. Uncoordinated, a resume can land several identical
 * 200-row queries inside a second — the burst production logs showed.
 *
 * Semantics, keyed by full URL so different filters never collide:
 * - default: join the in-flight request, else reuse a result younger than
 *   FRESH_MS, else fetch. Right for passive readers (badge, wake handlers).
 * - `force: true`: always start a new request — for post-mutation refreshes
 *   that must observe the change, never a response issued before it. The
 *   new request becomes the shared in-flight for later callers.
 *
 * Failures resolve to `null` and keep the last good data; callers treat
 * null as "keep what you have" exactly as they treat a non-OK response. A
 * 401 also sends the browser to sign in again.
 */
import { signedOut } from "@/lib/auth/expired-session";
import type { SessionSummary } from "@/types";

export interface SessionListResponse {
  sessions?: SessionSummary[];
}

const FRESH_MS = 2_000;

interface Entry {
  inflight?: Promise<SessionListResponse | null>;
  data?: SessionListResponse;
  at: number;
}

const entries = new Map<string, Entry>();

export async function fetchSessionList(
  url: string,
  opts: { force?: boolean } = {},
): Promise<SessionListResponse | null> {
  const existing = entries.get(url);
  if (!opts.force) {
    if (existing?.inflight) return existing.inflight;
    if (existing?.data && Date.now() - existing.at < FRESH_MS) return existing.data;
  }
  const inflight = (async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (signedOut(res) || !res.ok) return null;
      return (await res.json()) as SessionListResponse;
    } catch {
      return null;
    }
  })();
  entries.set(url, { data: existing?.data, at: existing?.at ?? 0, inflight });
  const data = await inflight;
  entries.set(url, { data: data ?? existing?.data, at: Date.now() });
  return data;
}
