/**
 * POST /api/chat/sessions/pin — pin or unpin a chat for the caller.
 * Body `PinRequest` `{ sessionId, pinned, profile? }`; answers `PinResponse`.
 * Forwards to the Python API `POST /api/sessions/{id}/pin`. Pins are per
 * user and per profile; re-sending the same request is a no-op.
 */
import { NextResponse } from "next/server";

import { readJson, withPinClient, unauthenticated } from "@/app/api/chat/pin-bff";
import { getPrincipal } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import type { PinResponse } from "@/types/landing";

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "missing_pinned" }, { status: 400 });
  }
  const pinned = body.pinned;
  return withPinClient(
    profileFromBody(body),
    (client): Promise<PinResponse> => client.setSessionPinned(sessionId, pinned),
  );
}
