/** PUT /api/skills/toggle — enable/disable a skill for one profile (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";

export async function PUT(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  if (!name || typeof body.enabled !== "boolean") return badRequest("name and enabled are required.");
  const enabled = body.enabled;
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.toggleSkill(name, enabled));
}
