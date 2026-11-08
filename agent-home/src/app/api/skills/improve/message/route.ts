/** POST /api/skills/improve/message — one turn of an improve chat; returns the reply and any proposed SKILL.md (owner/admin). */
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";
import type { ImproveReply } from "@/lib/skills/improve";

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const sessionId = str(body.session_id);
  const text = str(body.text);
  if (!sessionId || !text) return badRequest("session_id and text are required.");
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.request<ImproveReply>("/api/skills/improve/message", { method: "POST", json: { session_id: sessionId, text } }),
    (data): ImproveReply => ({
      reply: typeof data.reply === "string" ? data.reply : "",
      ...(typeof data.draft === "string" && data.draft ? { draft: data.draft } : {}),
    }),
  );
}
