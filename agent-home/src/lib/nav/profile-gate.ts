/**
 * Pages that may render while the session works in a non-default profile
 * (FG-28 B3).
 *
 * Until the legacy resolver is profile-aware (B4), every Python route outside
 * chat and the members console ignores `?profile=` and answers from the
 * profile the AI layer runs as (`default`). Rendering those pages under
 * another profile's name would show default's goals, memory or settings as if
 * they were that profile's — so in a non-default session every page is gated
 * unless it is listed here. New pages are therefore gated until someone says
 * otherwise, which is the safe direction.
 */
import { normalizePath } from "@/lib/nav/menu-access";

/** The profile the AI layer serves when a request names none. */
export const ACTING_PROFILE = "default";

/** Where a gated page is rewritten to (the address bar keeps the original URL). */
export const DEFAULT_PROFILE_ONLY_PATH = "/default-profile-only";

/** Page prefixes that honour the session profile or carry no profile data. */
const PROFILE_AWARE_PAGES: readonly string[] = [
  "/chat",
  "/users",
  "/members",
  // Signed-out / token pages: no profile data behind them.
  "/login",
  "/setup",
  "/activate",
  "/survey",
  "/fb",
  "/not-available",
  DEFAULT_PROFILE_ONLY_PATH,
];

/** Non-page paths the gate never touches: APIs, local apps, `public/` folders. */
const NOT_PAGES: readonly string[] = [
  "/api",
  "/_next",
  "/apps",
  "/apps-dev",
  "/icons",
  "/providers",
  "/seminar",
];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * True when `pathname` is a page that must not render for a session in
 * `profile`: a non-default profile and a page that only knows `default`.
 */
export function gatedToDefaultProfile(pathname: string, profile: string | undefined): boolean {
  if (!profile || profile === ACTING_PROFILE) return false;
  const path = normalizePath(pathname);
  if (NOT_PAGES.some((p) => under(path, p))) return false;
  // Top-level `public/` files (`/sw.js`, `/manifest.webmanifest`). Deeper
  // paths are not exempt: `/skills/x.md` is a page.
  if (/^\/[^/]+\.[a-z0-9]+$/i.test(path)) return false;
  return !PROFILE_AWARE_PAGES.some((p) => under(path, p));
}
