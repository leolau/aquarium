/** GET /api/skills/versions — a skill's saved versions and which one is active (owner/admin). */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";
import type { SkillVersionList } from "@/lib/skills/improve";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
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
