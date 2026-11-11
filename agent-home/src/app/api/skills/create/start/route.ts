/** POST /api/skills/create/start — open a "New skill with AI" chat, optionally for a project (Skills permissions: lab). */
import { BAD_JSON, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import type { CreateSkillStart } from "@/lib/skills/create";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const profile = profileFromBody(body);
  const gate = await requireSkillPermission("lab", profile);
  if (!gate.ok) return gate.response;
  const cardIds = Array.isArray(body.card_ids) ? body.card_ids.map(String).filter(Boolean) : [];
  const json: CreateSkillStart = {
    ...(profile ? { profile } : {}),
    ...(str(body.project) ? { project: str(body.project) } : {}),
    ...(str(body.goal) ? { goal: str(body.goal) } : {}),
    ...(str(body.candidate_id) ? { candidate_id: str(body.candidate_id) } : {}),
    ...(cardIds.length ? { card_ids: cardIds } : {}),
  };
  const client = await apiClientForRequest({ profile });
  return upstream(
    () => client.request<{ session_id: string }>("/api/skills/create/start", { method: "POST", json }),
    (data) => ({ session_id: String(data.session_id) }),
  );
}
