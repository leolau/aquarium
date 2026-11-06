/**
 * Which profile a login lands in (FG-28 D1).
 *
 * Accounts are box-wide but authority is profile-local, so the person may be
 * enrolled in several profiles, in none, or only in suspended ones. The answer
 * is always one of their *active* enrolments: a requested name or the
 * browser's hint is a preference among those, never a grant.
 */
import type { MyProfile } from "@/types";

export type LandingChoice =
  | { kind: "profile"; profile: string }
  | { kind: "suspended" }
  | { kind: "none" };

export function chooseLandingProfile(
  enrolments: readonly MyProfile[],
  prefs: { requested?: string | null; hint?: string | null } = {},
): LandingChoice {
  const active = enrolments.filter((e) => e.active);
  if (active.length === 0) {
    return enrolments.length > 0 ? { kind: "suspended" } : { kind: "none" };
  }
  const enrolled = (name: string | null | undefined) =>
    active.find((e) => e.name === (name ?? "").trim());
  const pick =
    enrolled(prefs.requested) ??
    enrolled(prefs.hint) ??
    active.find((e) => e.is_default) ??
    active[0];
  return { kind: "profile", profile: pick.name };
}
