/** POST /api/skills/create/message — one turn of a "New skill with AI" chat; returns the reply and any SKILL.md draft (Skills permissions: lab). */
import { BAD_JSON, badRequest, readJsonBody, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import type { ImproveReply } from "@/lib/skills/improve";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const profile = profileFromBody(body);
  const gate = await requireSkillPermission("lab", profile);
  if (!gate.ok) return gate.response;
  const sessionId = str(body.session_id);
  const text = str(body.text);
  if (!sessionId || !text) return badRequest("session_id and text are required.");
  const client = await apiClientForRequest({ profile });
  return upstream(
    () =>
      client.request<ImproveReply>("/api/skills/create/message", {
        method: "POST",
        json: { session_id: sessionId, text, ...(profile ? { profile } : {}) },
      }),
    (data): ImproveReply => ({
      reply: typeof data.reply === "string" ? data.reply : "",
      ...(typeof data.draft === "string" && data.draft ? { draft: data.draft } : {}),
    }),
  );
}
