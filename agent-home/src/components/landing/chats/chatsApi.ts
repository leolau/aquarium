"use client";

import { sendProjectAction, newIdempotencyKey } from "@/components/projects/useProjectAction";
import { withProfileQuery } from "@/lib/chat/profile";
import { fetchSessionList } from "@/lib/chat/session-list-fetch";
import { LANDING_ROUTES, landingApi } from "@/lib/landing/api";
import type { PinResponse, PinSuggestionsResponse } from "@/types/landing";
import type { ProfileSummary, SessionCreateResponse } from "@/types";

import type { MessageSearchHit } from "./MessageSearch";
import type { LandingSession } from "./model";

/**
 * Thin adapter over the landing contract for the chats sidebar. Reads keep
 * the last good data (null on failure); writes carry an Idempotency-Key via
 * `sendProjectAction`. A 404 on a pin route means the pins workstream is not
 * deployed — callers hide the pin UI instead of showing an error.
 */

export const SIDEBAR_SESSION_LIMIT = 100;

export type WriteOutcome<T> =
  | { ok: true; data: T | null }
  | { ok: false; unsupported: boolean; error: string };

async function write<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<WriteOutcome<T>> {
  const res = await sendProjectAction<T>(path, newIdempotencyKey(), { method, body }, fetchImpl);
  if (res.ok) return { ok: true, data: res.data };
  return {
    ok: false,
    unsupported: res.status === 404 || res.status === 405 || res.status === 501,
    error: res.error ?? "That did not go through.",
  };
}

function profileBody(profile: string | undefined): { profile?: string } {
  return profile && profile !== "default" ? { profile } : {};
}

export const chatsApi = {
  async sessions(
    profile: string | undefined,
    opts: { force?: boolean } = {},
  ): Promise<LandingSession[] | null> {
    const url = withProfileQuery(`/api/chat/sessions?limit=${SIDEBAR_SESSION_LIMIT}`, profile);
    const body = await fetchSessionList(url, opts);
    return body?.sessions ? (body.sessions as LandingSession[]) : null;
  },

  /** Every conversation's messages (`GET /api/chat/sessions/search`). */
  async searchMessages(
    q: string,
    signal: AbortSignal,
    profile: string | undefined,
  ): Promise<MessageSearchHit[]> {
    const res = await fetch(
      withProfileQuery(`/api/chat/sessions/search?q=${encodeURIComponent(q)}`, profile),
      { cache: "no-store", signal },
    );
    if (!res.ok) throw new Error("Message search failed.");
    const body = (await res.json()) as { results?: MessageSearchHit[] };
    return body.results ?? [];
  },

  async profiles(fetchImpl: typeof fetch = fetch): Promise<ProfileSummary[] | null> {
    try {
      const res = await fetchImpl("/api/chat/profiles", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { profiles?: ProfileSummary[] };
      return Array.isArray(body.profiles) ? body.profiles : null;
    } catch {
      return null;
    }
  },

  pinSuggestions(profile: string | undefined): Promise<PinSuggestionsResponse | null> {
    return landingApi.pinSuggestions(profile && profile !== "default" ? profile : undefined);
  },

  setPinned(
    sessionId: string,
    pinned: boolean,
    profile: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ): Promise<WriteOutcome<PinResponse>> {
    return write<PinResponse>(
      LANDING_ROUTES.pin,
      "POST",
      { sessionId, pinned, ...profileBody(profile) },
      fetchImpl,
    );
  },

  dismissSuggestions(
    sessionIds: string[],
    profile: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ): Promise<WriteOutcome<unknown>> {
    return write(
      LANDING_ROUTES.dismissPinSuggestions,
      "POST",
      { sessionIds, ...profileBody(profile) },
      fetchImpl,
    );
  },

  archive(
    sessionId: string,
    archived: boolean,
    profile: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ): Promise<WriteOutcome<unknown>> {
    return write(
      "/api/chat/sessions/archive",
      "PATCH",
      { sessionId, archived, ...profileBody(profile) },
      fetchImpl,
    );
  },
  rename(
    sessionId: string,
    title: string,
    profile: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ): Promise<WriteOutcome<{ ok?: boolean; title?: string }>> {
    return write(
      "/api/chat/sessions/rename",
      "PATCH",
      { sessionId, title, ...profileBody(profile) },
      fetchImpl,
    );
  },

  newChat(
    profile: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ): Promise<WriteOutcome<SessionCreateResponse>> {
    return write<SessionCreateResponse>("/api/chat/new", "POST", profileBody(profile), fetchImpl);
  },
};

/** Where a conversation opens: the chat page, in the conversation's profile. */
/** The landing page with that chat open in its centre column. */
export function landingChatHref(sessionId: string, profile: string | undefined): string {
  const params = new URLSearchParams({ chat: sessionId });
  if (profile && profile !== "default") params.set("profile", profile);
  return `/?${params.toString()}`;
}

export function chatHref(sessionId: string, profile: string | undefined): string {
  const params = new URLSearchParams({ session: sessionId });
  if (profile && profile !== "default") params.set("profile", profile);
  return `/chat?${params.toString()}`;
}
