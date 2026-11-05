/**
 * POST /api/skills/hub/install — install a hub skill into one profile.
 * The install policy (dangerous = blocked, caution = confirm) is enforced by
 * the hub installer itself; the page asks for confirmation before calling.
 */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const identifier = str(body.identifier);
  if (!identifier) return badRequest("identifier is required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.installHubSkill(identifier), (data) => ({ ok: data.ok !== false }));
}
