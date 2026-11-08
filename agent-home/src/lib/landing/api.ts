import type {
  LandingBarResponse,
  NeedsYouResponse,
  PinResponse,
  PinSuggestionsResponse,
} from "@/types/landing";

/**
 * Browser-side reads for the landing page. Each returns `null` when the
 * route is missing or failing so callers keep their last good data.
 * Writes (pin, dismiss, needs-you actions) go through the existing
 * mutation hooks so they get the click lock and Idempotency-Key.
 */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store", method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const landingApi = {
  bar: () => getJson<LandingBarResponse>("/api/landing/bar"),
  needsYou: (opts?: { countOnly?: boolean }) =>
    getJson<NeedsYouResponse>(
      opts?.countOnly ? "/api/needs-you?include=count" : "/api/needs-you",
    ),
  pinSuggestions: (profile?: string) =>
    getJson<PinSuggestionsResponse>(
      `/api/chat/pin-suggestions${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`,
    ),
};

export const LANDING_ROUTES = {
  pin: "/api/chat/sessions/pin",
  dismissPinSuggestions: "/api/chat/pin-suggestions/dismiss",
} as const;

export type { PinResponse };
