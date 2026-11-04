/** GET /api/skills/hub/scan?identifier= — security scan a hub skill before installing. */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const identifier = str(new URL(request.url).searchParams.get("identifier"));
  if (!identifier) return badRequest("identifier is required.");
  const client = await apiClientForRequest();
  return upstream(() => client.skillHubScan(identifier));
}
