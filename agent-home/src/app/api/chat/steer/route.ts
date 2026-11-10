/**
 * POST /api/chat/steer — send a message to a turn that is still running.
 * Body: `{ sessionId, runId, text, mode, profile? }` where `mode` is
 * `steer` (read after the agent's current step), `queue` (run as the next
 * turn) or `interrupt` (stop now, then run it). Forwards to the Python
 * `POST /api/sessions/{id}/chat/stream/steer`; a 409 `run_finished` means the
 * run ended first and the client sends a normal turn instead.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import type { ChatInputMode } from "@/types";

const MODES: readonly ChatInputMode[] = ["steer", "queue", "interrupt"];

interface SteerBody {
  sessionId?: unknown;
  runId?: unknown;
  text?: unknown;
  mode?: unknown;
  profile?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json(
      { error: "unauthenticated", detail: "Sign in to continue." },
      { status: 401 },
    );
  }
  let body: SteerBody;
  try {
    body = (await request.json()) as SteerBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "Malformed request body." },
      { status: 400 },
    );
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!sessionId || !runId) {
    return NextResponse.json(
      { error: "missing_ids", detail: "sessionId and runId are required." },
      { status: 400 },
    );
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { error: "empty_message", detail: "A message is required." },
      { status: 400 },
    );
  }
  const mode = (body.mode ?? "steer") as ChatInputMode;
  if (!MODES.includes(mode)) {
    return NextResponse.json(
      { error: "bad_mode", detail: "mode must be steer, queue or interrupt." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const resp = await client.steerChatRun(sessionId, runId, text, mode);
    return NextResponse.json(resp);
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
