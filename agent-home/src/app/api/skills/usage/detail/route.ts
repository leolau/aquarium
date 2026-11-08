/** GET /api/skills/usage/detail — one skill's recorded runs, newest first (owner/admin). */
import { badRequest, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const params = new URL(request.url).searchParams;
  const name = str(params.get("name"));
  if (!name) return badRequest("name is required.");
  const query = new URLSearchParams({ name });
  for (const key of ["days", "limit"]) {
    const value = str(params.get(key));
    if (/^\d{1,4}$/.test(value)) query.set(key, value);
  }
  const cursor = str(params.get("cursor"));
  if (cursor) query.set("cursor", cursor);
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.request<unknown>(`/api/skills/usage/detail?${query}`));
}
