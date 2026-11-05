/** POST /api/skills/hub/uninstall — remove a hub-installed skill from one profile. */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  if (!name) return badRequest("name is required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.uninstallHubSkill(name), (data) => ({ ok: data.ok !== false }));
}
