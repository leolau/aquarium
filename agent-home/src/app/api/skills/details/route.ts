/** GET /api/skills/details — a skill's files, last change and the profiles that have it (owner/admin). */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";
import type { SkillDetails } from "@/types";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const name = str(new URL(request.url).searchParams.get("name"));
  if (!name) return badRequest("name is required.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillDetails(name), toSkillDetails);
}

/** Only the documented fields reach the browser (file paths stay relative). */
function toSkillDetails(data: SkillDetails): SkillDetails {
  return {
    name: data.name,
    files: (data.files ?? []).map((f) => ({ path: f.path, size: f.size })),
    files_truncated: Boolean(data.files_truncated),
    modified_at: typeof data.modified_at === "number" ? data.modified_at : null,
    used_by: (data.used_by ?? []).map((u) => ({ profile: u.profile, enabled: Boolean(u.enabled) })),
  };
}
