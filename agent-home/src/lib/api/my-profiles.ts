import type { MyProfilesResponse, ProfileSummary } from "@/types";

/**
 * The profiles a signed-in account may chat in: its active enrolments (FG-28
 * D3). A suspended enrolment carries no authority, so it is not offered.
 */
export function activeEnrolments(res: MyProfilesResponse): ProfileSummary[] {
  return (res.profiles ?? [])
    .filter((p) => p.active)
    .map((p) => ({ name: p.name, is_default: Boolean(p.is_default), description: "" }));
}

/**
 * The profiles an account may administer from the Users screen (FG-28 C3):
 * its active enrolments as owner or admin. Authority is profile-local, so
 * being an admin in `hr` says nothing about `default` — each entry is judged
 * on that profile's own role. Python re-checks every request regardless.
 */
export function administeredProfiles(res: MyProfilesResponse): ProfileSummary[] {
  return (res.profiles ?? [])
    .filter((p) => p.active && (p.role === "owner" || p.role === "admin"))
    .map((p) => ({ name: p.name, is_default: Boolean(p.is_default), description: "" }));
}

/**
 * Which profile `/users?profile=` shows: the requested one when the account
 * administers it, otherwise the session's own. A typo'd, stale or foreign
 * name never becomes the target — it is simply not on the list.
 */
export function selectUsersProfile(
  requested: string | undefined,
  administered: ProfileSummary[],
  sessionProfile: string,
): string {
  const name = requested?.trim();
  return name && administered.some((p) => p.name === name) ? name : sessionProfile;
}
