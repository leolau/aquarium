/** GET /api/skills/hub/sources — hub sources, featured skills, what's installed. */
import { upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("manage", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillHubSources());
}
