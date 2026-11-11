/** POST /api/skills/hub/uninstall — remove a hub-installed skill from one profile. */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("manage", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  if (!name) return badRequest("name is required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.uninstallHubSkill(name), (data) => ({ ok: data.ok !== false }));
}
