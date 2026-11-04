/** GET/PUT /api/skills/content — read or rewrite a skill's SKILL.md (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
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
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("name and content are required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.updateSkillContent(name, content),
    (data) => ({ ok: data.success !== false, message: data.message ?? null }),
  );
}
