/** GET /api/skills/hub/scan?identifier= — security scan a hub skill before installing. */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(request: Request) {
  // Browsing the hub is sign-in only (as in Python); installing needs `manage`.
  const principal = await getPrincipal();
  if (!principal) return refuse(principal);
  const identifier = str(new URL(request.url).searchParams.get("identifier"));
  if (!identifier) return badRequest("identifier is required.");
  const client = await apiClientForRequest();
  return upstream(() => client.skillHubScan(identifier));
}
