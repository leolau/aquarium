/** GET /api/skills/details — a skill's files, last change and the profiles that have it (Skills permissions). */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";
import type { SkillDetails } from "@/types";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("manage", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
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
