/** GET /api/skills/hub/scan?identifier= — security scan a hub skill before installing. */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("manage", undefined);
  if (!gate.ok) return gate.response;
  const identifier = str(new URL(request.url).searchParams.get("identifier"));
  if (!identifier) return badRequest("identifier is required.");
  const client = await apiClientForRequest();
  return upstream(() => client.skillHubScan(identifier));
}
