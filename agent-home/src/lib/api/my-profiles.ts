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
