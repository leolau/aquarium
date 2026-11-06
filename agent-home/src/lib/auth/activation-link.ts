/**
 * The two activation link shapes (FG-28 C2): `/activate/<token>` — the
 * default profile, and every link minted before profiles travelled in it —
 * and `/activate/<profile>/<token>` for a named profile.
 *
 * The profile is routing metadata, not a grant: it picks which profile's
 * invitations the server searches, and the token is hash-bound to the profile
 * it was minted in, so a link edited to name another profile is refused with
 * the same neutral answer as any bad token.
 */
export interface ActivationLink {
  token: string;
  profile?: string;
}

/** Parse the `/activate/...` segments; `null` for any other shape. */
export function parseActivationLink(segments: readonly string[]): ActivationLink | null {
  const parts = segments.map((s) => s.trim());
  if (parts.some((s) => !s)) return null;
  if (parts.length === 1) return { token: parts[0] };
  if (parts.length === 2) return { profile: parts[0], token: parts[1] };
  return null;
}

/** Where to sign in after activating: into the profile the link was for. */
export function loginPathAfterActivation(profile?: string): string {
  return profile ? `/login?profile=${encodeURIComponent(profile)}` : "/login";
}
