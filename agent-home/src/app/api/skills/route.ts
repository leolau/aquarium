/**
 * GET/POST /api/skills — the owner/admin Skills page. `?profile=` (or the
 * body's `profile`) picks whose skills; the client binds it so every call
 * lands on that profile's own skills directory.
 */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.skillList());
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("A skill needs a name and SKILL.md content.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.createSkill({ name, content, category: str(body.category) || undefined }),
    (data) => ({ ok: data.success !== false, message: data.message ?? null }),
  );
}
