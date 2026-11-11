/**
 * POST /api/skills/hub/install — install a hub skill into one profile.
 * The install policy (dangerous = blocked, caution = confirm) is enforced by
 * the hub installer itself; the page asks for confirmation before calling.
 */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("manage", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const identifier = str(body.identifier);
  if (!identifier) return badRequest("identifier is required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.installHubSkill(identifier), (data) => ({ ok: data.ok !== false }));
}
