/** POST /api/skills/improve/start — open an improve chat for one skill (Skills permissions). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("lab", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  if (!name) return badRequest("name is required.");
  const goal = str(body.goal);
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.request<{ session_id: string }>("/api/skills/improve/start", { method: "POST", json: goal ? { name, goal } : { name } }),
    (data) => ({ session_id: String(data.session_id) }),
  );
}
