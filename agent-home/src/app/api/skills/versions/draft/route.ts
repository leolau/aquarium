/** POST /api/skills/versions/draft — save a SKILL.md as a new draft version; the live skill is untouched (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";
import type { SkillVersionMeta } from "@/lib/skills/improve";

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("name and content are required.");
  const json: Record<string, string> = { name, content, message: str(body.message) };
  // Editing a saved draft builds on that draft, not on the active version.
  const base = str(body.base);
  if (base) json.base = base;
  // An improve chat's draft is credited to that chat (C-3).
  const sessionId = str(body.session_id);
  if (sessionId) {
    json.session_id = sessionId;
    json.author = `agent:${sessionId}`;
    json.source = "improve";
  }
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(() => client.request<SkillVersionMeta>("/api/skills/versions/draft", { method: "POST", json }));
}
