/**
 * Pages that stay in the default profile while the session works in another
 * (FG-28 B3).
 *
 * Since B4 every profile-local Python route honours `?profile=`, so pages
 * follow the session profile. The exceptions are pages built on box-wide
 * routes (the files store and folder browser, capacity, software upgrade):
 * they act on the whole box, Python refuses a non-acting `?profile=` on them,
 * and the client never sends one (`isBoxWidePath`). Shown under another
 * profile's name they would present box state as if it were that profile's,
 * so they render only in `default`.
 */
import { normalizePath } from "@/lib/nav/menu-access";

/** The profile the AI layer serves when a request names none. */
export const ACTING_PROFILE = "default";

/** Where a gated page is rewritten to (the address bar keeps the original URL). */
export const DEFAULT_PROFILE_ONLY_PATH = "/default-profile-only";

/** Page prefixes whose content is the whole box, not one profile. */
export const BOX_WIDE_PAGES: readonly string[] = ["/files", "/capacity", "/settings/upgrade"];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * True when `pathname` is a page that must not render for a session in
 * `profile`: a non-default profile and a page about the whole box.
 */
export function gatedToDefaultProfile(pathname: string, profile: string | undefined): boolean {
  if (!profile || profile === ACTING_PROFILE) return false;
  const path = normalizePath(pathname);
  return BOX_WIDE_PAGES.some((p) => under(path, p));
}
