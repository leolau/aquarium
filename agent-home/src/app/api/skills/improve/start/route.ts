/** POST /api/skills/improve/start — open an improve chat for one skill (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const name = str(body.name);
  if (!name) return badRequest("name is required.");
  const goal = str(body.goal);
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.request<{ session_id: string }>("/api/skills/improve/start", { method: "POST", json: goal ? { name, goal } : { name } }),
    (data) => ({ session_id: String(data.session_id) }),
  );
}
