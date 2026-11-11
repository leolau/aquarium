/** GET /api/skills/usage/detail — one skill's recorded runs, newest first (Skills permissions). */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("lab", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
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
