/**
 * POST /api/chat/stream — BFF streaming send-one-turn with approval surface.
 *
 * Body: `{ sessionId?, message, attachments?, profile? }`. When `sessionId` is absent a
 * conversation is created first. Proxies the SSE stream from the Python API
 * `POST /api/sessions/{id}/chat/stream` under the bridged C1 principal so the
 * browser gets live assistant deltas AND `approval.request` events for
 * tool-approval-gated tools (which the non-streaming `/api/chat/send` path
 * cannot surface). The resolved session id is returned in the
 * `X-Hermes-Session-Id` header so the client can attribute a new conversation.
 * The browser never calls the AI layer directly and never re-implements the loop.
 */
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";
import { mediaRef } from "@/lib/chat/media-ref";
import { withUiContext } from "@/lib/chat/ui-context";
import { canReadMediaPath, createMediaSignedUrl } from "@/lib/supabase/storage";
import type { AgentAttachmentPayload, ChatAttachment, Principal } from "@/types";

interface SendBody {
  sessionId?: unknown;
  message?: unknown;
  attachments?: unknown;
  /** Which profile's brain answers this turn (FG-28); default when absent. */
  profile?: unknown;
  /**
   * app-mcp awareness: one line describing the page and element the user is
   * on, reported by the browser bridge. Prepended to the message so the
   * agent can understand references like "this page" or "the button I'm on".
   */
  uiContext?: unknown;
}

function withAttachments(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;
  const refs = attachments
    .map((a) => {
      // Images embed inline (`![]`) for a preview; any other file type
      // (PDF/DOC/XLS/…) is a download link (`[]`) so it isn't treated as a
      // broken image.
      const marker = a.content_type.startsWith("image/") ? "!" : "";
      return `${marker}[${a.name}](${mediaRef(a.path)})`;
    })
    .join("\n");
  return message ? `${message}\n\n${refs}` : refs;
}

function readAttachments(principal: Principal, raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as ChatAttachment).path === "string" &&
      typeof (item as ChatAttachment).name === "string" &&
      canReadMediaPath(principal, (item as ChatAttachment).path)
    ) {
      const a = item as ChatAttachment;
      out.push({
        path: a.path,
        name: a.name,
        content_type: typeof a.content_type === "string" ? a.content_type : "",
        size: typeof a.size === "number" ? a.size : 0,
      });
    }
  }
  return out;
}

/**
 * Turn owned attachments into the per-turn payload the Python chat endpoint
 * downloads once. The transcript keeps only the durable object `path`; here we
 * mint a short-lived signed URL per file so the box can fetch the bytes into
 * its document cache and make the upload readable by the brain. An attachment
 * that fails to sign is dropped (the transcript link still renders) rather than
 * failing the whole turn.
 */
async function signAttachments(
  attachments: ChatAttachment[],
): Promise<AgentAttachmentPayload[]> {
  const signed = await Promise.all(
    attachments.map(async (a) => {
      const s = await createMediaSignedUrl(a.path).catch(() => null);
      if (!s) return null;
      return {
        name: a.name,
        content_type: a.content_type,
        size: a.size,
        url: s.url,
      } satisfies AgentAttachmentPayload;
    }),
  );
  return signed.filter((x): x is AgentAttachmentPayload => x !== null);
}

function jsonError(error: string, detail: string, status: number): Response {
  return new Response(JSON.stringify({ error, detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The live run's id from a 409 `turn_in_progress` (top level, or nested in a
 * FastAPI `detail` object), so the client can steer it instead of failing.
 */
function turnInProgressRunId(raw: unknown): string | null {
  let body = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  const top = body as { detail?: unknown; run_id?: unknown };
  const nested =
    top.detail && typeof top.detail === "object"
      ? (top.detail as { detail?: unknown; run_id?: unknown })
      : null;
  const detail = nested ? nested.detail : top.detail;
  const runId = nested?.run_id ?? top.run_id;
  return detail === "turn_in_progress" && typeof runId === "string" && runId ? runId : null;
}

export async function POST(request: Request): Promise<Response> {
  const principal = await getPrincipal();
  if (!principal) {
    return jsonError("unauthenticated", "Sign in to continue.", 401);
  }

  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return jsonError("invalid_json", "Malformed request body.", 400);
  }

  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const attachments = readAttachments(principal, body.attachments);
  if (!rawMessage && attachments.length === 0) {
    return jsonError("empty_message", "A message or attachment is required.", 400);
  }
  const message = withUiContext(withAttachments(rawMessage, attachments), body.uiContext);

  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    let sessionId =
      typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
    if (!sessionId) {
      const created = await client.createSession();
      sessionId = created.session_id;
    }
    const agentAttachments = await signAttachments(attachments);
    const upstream = await client.openChatStream(
      sessionId,
      message,
      agentAttachments,
    );
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "x-hermes-session-id": sessionId,
      },
    });
  } catch (err) {
    if (err instanceof HermesApiError) {
      const busyRunId = err.status === 409 ? turnInProgressRunId(err.body) : null;
      if (busyRunId) {
        return new Response(
          JSON.stringify({ error: "turn_in_progress", detail: "turn_in_progress", runId: busyRunId }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return jsonError("api_error", err.message, err.status);
    }
    return jsonError("api_unreachable", "The AI layer could not be reached.", 502);
  }
}
