/** POST /api/skills/usage/feedback — mark one run Helpful (1) or Not helpful (-1), with an optional note (Skills permissions). */
import { BAD_JSON, badRequest, readJsonBody, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { requireSkillPermission } from "@/lib/skills/permissions-server";

import { toUsageEvent } from "../shape";

const NOTE_MAX = 2000;

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const gate = await requireSkillPermission("lab", profileFromBody(body));
  if (!gate.ok) return gate.response;
  const eventId = body.event_id;
  const rating = body.rating;
  if (typeof eventId !== "number" || !Number.isInteger(eventId) || eventId < 1) return badRequest("event_id is required.");
  if (rating !== 1 && rating !== -1) return badRequest("rating must be 1 or -1.");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return badRequest("note must be text.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : "";
  const client = await apiClientForRequest({ profile: profileFromBody(body) });
  return upstream(
    () => client.skillUsageFeedback({ event_id: eventId, rating, ...(note ? { note } : {}) }),
    toUsageEvent,
  );
}
