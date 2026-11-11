/** GET /api/skills/versions — a skill's saved versions and which one is active (Skills permissions). */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import type { SkillVersionList } from "@/lib/skills/improve";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("lab", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const name = str(new URL(request.url).searchParams.get("name"));
  if (!name) return badRequest("name is required.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(
    () => client.request<SkillVersionList>(`/api/skills/versions?name=${encodeURIComponent(name)}`),
    (data): SkillVersionList => ({
      name: data.name ?? name,
      active: data.active ?? null,
      versions: Array.isArray(data.versions) ? data.versions : [],
    }),
  );
}
