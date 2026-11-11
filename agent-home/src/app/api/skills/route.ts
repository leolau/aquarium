/**
 * GET/POST /api/skills — the Skills page (gated by Skills permissions). `?profile=` (or the
 * body's `profile`) picks whose skills; the client binds it so every call
 * lands on that profile's own skills directory.
 */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function GET(request: Request) {
  const gate = await requireSkillPermission("view", profileFromUrl(request.url));
  if (!gate.ok) return gate.response;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillList());
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("manage", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("A skill needs a name and SKILL.md content.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.createSkill({ name, content, category: str(body.category) || undefined }),
    (data) => ({ ok: data.success !== false, message: data.message ?? null }),
  );
}
