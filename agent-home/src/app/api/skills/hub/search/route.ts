/** GET /api/skills/hub/search?q= — search every skills hub source. */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("manage", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const q = str(new URL(request.url).searchParams.get("q"));
  if (!q) return badRequest("Type something to search for.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillHubSearch(q));
}
