"use client";

import { useEffect, useState } from "react";

import { onSessionsChanged } from "@/lib/chat/sessions-changed";

import { chatsApi } from "./chatsApi";
import {
  USER_CHAT_SOURCE,
  isUserStartedChat,
  latestSession,
  type LandingSession,
} from "./model";

/**
 * The chat the landing composer offers "Continue" for: the user-started
 * chat touched last — the same chat the sidebar marks with its Continue
 * badge (`latestSession` over the same filtered list).
 *
 * Reads `GET /api/chat/sessions` through the shared coalescing fetch, so a
 * mount here joins the sidebar's in-flight request instead of issuing a
 * second one. Refreshes on the same signals the sidebar uses — a
 * sessions-changed event forces a re-read so the chip observes the change,
 * a focus/visibility resume reuses the 2 s freshness window. Failures keep
 * the last good data; the chip simply stays hidden until a chat exists.
 */
export function useResumeChat(profile?: string): LandingSession | null {
  const [list, setList] = useState<LandingSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = (force = false) =>
      void chatsApi.sessions(profile, { force, source: USER_CHAT_SOURCE }).then((all) => {
        if (!cancelled && all) setList(all.filter(isUserStartedChat));
      });
    load();
    const off = onSessionsChanged((detail) => {
      if (detail.profile && profile && detail.profile !== profile) return;
      load(true);
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      off();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [profile]);

  return latestSession(list);
}
