/** GET/PUT /api/skills/content — read or rewrite a skill's SKILL.md (Skills permissions). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("view", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const name = str(new URL(request.url).searchParams.get("name"));
  if (!name) return badRequest("name is required.");
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  // The upstream also returns the file's path; the browser never sees it.
  return upstream(
    () => client.skillContent(name),
    (data) => ({ name: data.name, content: data.content }),
  );
}

export async function PUT(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("manage", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("name and content are required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.updateSkillContent(name, content),
    (data) => ({ ok: data.success !== false, message: data.message ?? null }),
  );
}
