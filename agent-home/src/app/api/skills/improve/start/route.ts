/**
 * POST /api/skills/improve/start — open an improve chat for one skill (Skills permissions).
 * `project` (a slug) scopes the evidence to that project; the backend checks project read.
 */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { PROJECT_SLUG } from "@/lib/skills/improve";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("lab", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const name = str(body.name);
  if (!name) return badRequest("name is required.");
  const goal = str(body.goal);
  const project = str(body.project);
  if (project && !PROJECT_SLUG.test(project)) return badRequest("project is not a valid project slug.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.request<{ session_id: string }>("/api/skills/improve/start", { method: "POST", json: { name, ...(goal ? { goal } : {}), ...(project ? { project } : {}) } }),
    (data) => ({ session_id: String(data.session_id) }),
  );
}
