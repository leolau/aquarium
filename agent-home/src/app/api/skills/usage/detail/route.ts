/** GET /api/skills/usage/detail — one skill's recorded runs, newest first (Skills permissions); `project=` narrows to one project. */
import { badRequest, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
  // Only this project's runs (project Skills tab); the server also checks the
  // caller can read the project.
  const project = str(params.get("project"));
  if (project) {
    if (!PROJECT_SLUG.test(project)) return badRequest("Invalid project.");
    query.set("project", project);
  }
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.request<unknown>(`/api/skills/usage/detail?${query}`));
}
