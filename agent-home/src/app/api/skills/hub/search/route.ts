/** GET /api/skills/hub/search?q= — search every skills hub source. */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request) {
  // Browsing the hub is sign-in only (as in Python); installing needs `manage`.
  const principal = await getPrincipal();
  if (!principal) return refuse(principal);
  const q = str(new URL(request.url).searchParams.get("q"));
  if (!q) return badRequest("Type something to search for.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillHubSearch(q));
}
