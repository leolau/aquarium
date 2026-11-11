/** PUT /api/skills/toggle — enable/disable a skill for one profile (Skills permissions). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function PUT(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("manage", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  if (!name || typeof body.enabled !== "boolean") return badRequest("name and enabled are required.");
  const enabled = body.enabled;
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.toggleSkill(name, enabled));
}
