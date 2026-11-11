/** POST /api/skills/create/save — save an AI-written skill as a disabled draft (v1, not active) (Skills permissions: lab). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import type { CreateSkillSave, CreatedSkill } from "@/lib/skills/create";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const profile = profileFromBody(body);
  const gate = await requireSkillPermission("lab", profile);
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !content.trim()) return badRequest("name and content are required.");
  const json: CreateSkillSave = {
    name,
    content,
    ...(profile ? { profile } : {}),
    ...(str(body.category) ? { category: str(body.category) } : {}),
    ...(str(body.project) ? { project: str(body.project) } : {}),
    ...(str(body.session_id) ? { session_id: str(body.session_id) } : {}),
    ...(str(body.candidate_id) ? { candidate_id: str(body.candidate_id) } : {}),
  };
  const client = await apiClientForRequest({ profile });
  return upstream(
    () => client.request<CreatedSkill>("/api/skills/create/save", { method: "POST", json }),
    (data) => data,
  );
}
