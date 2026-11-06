/**
 * Naming a profile explicitly on a members-console request (FG-28 C1/C3).
 *
 * Unlike chat (`lib/chat/profile.ts`), where an absent profile and `default`
 * are the same thing, the admin console must be able to say `default` while
 * the session works in another profile: an admin switched to `hr` who picks
 * `default` on the Users screen means `default`, not "the session's profile".
 * So here `default` is a real value, and only an absent one falls back to the
 * session. Names are not validated against the registry — Python owns that and
 * refuses an unknown profile.
 */

/** Longest profile name accepted before asking Python (names are short slugs). */
export const MAX_PROFILE_NAME = 64;

/** A trimmed profile name, or undefined when absent or implausible. */
export function explicitProfile(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value && value.length <= MAX_PROFILE_NAME ? value : undefined;
}

/** `?profile=` off a request URL, `default` included. */
export function explicitProfileFromUrl(url: string): string | undefined {
  return explicitProfile(new URL(url).searchParams.get("profile"));
}

/**
 * Add the console's selected profile to a BFF path (browser side). Always
 * sent, `default` included, so a request never silently lands in whatever
 * profile the session happens to be working in.
 */
export function withProfileQuery(path: string, profile: string): string {
  const name = explicitProfile(profile);
  if (!name) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}profile=${encodeURIComponent(name)}`;
}
