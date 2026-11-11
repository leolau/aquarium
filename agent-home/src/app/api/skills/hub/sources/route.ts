/** GET /api/skills/hub/sources — hub sources, featured skills, what's installed. */
import { refuse, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request) {
  // Browsing the hub is sign-in only (as in Python); installing needs `manage`.
  const principal = await getPrincipal();
  if (!principal) return refuse(principal);
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillHubSources());
}
