/**
 * POST /api/chat/secret — BFF answer an FG-37 secret request from a streamed
 * chat turn.
 *
 * Body: `{ request_id, values }` to store the secret (`{value}` or
 * `{username, password}`), or `{ request_id, decline: true }`. Forwards to the
 * Python API `POST /api/secret-requests/{id}` under the bridged principal; the
 * value goes straight to the owner's credential store and the agent only ever
 * learns the name. Bodies are never logged or echoed, and error details are
 * fixed text (never upstream text), so a value cannot leak back into the UI.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";

interface SecretBody {
  request_id?: unknown;
  values?: unknown;
  decline?: unknown;
}

const REQUEST_ID_RE = /^sr_[A-Za-z0-9]{1,64}$/;
const VALUE_FIELDS = new Set(["value", "username", "password"]);
const MAX_VALUE_CHARS = 16_384;
const NO_STORE = { "Cache-Control": "no-store" };

function reply(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The values object if it is a well-formed secret/password answer, else null. */
function readValues(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALUE_FIELDS.has(key) || typeof val !== "string" || val.length > MAX_VALUE_CHARS) {
      return null;
    }
    out[key] = val;
  }
  if ("value" in out) return out.value && !("password" in out) ? out : null;
  return out.password ? out : null;
}

const UPSTREAM_DETAIL: Record<number, string> = {
  403: "This request belongs to someone else.",
  404: "This secret request is no longer open.",
  409: "This secret request was already answered or has expired.",
};

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return reply({ error: "unauthenticated" }, 401);

  let body: SecretBody;
  try {
    body = (await request.json()) as SecretBody;
  } catch {
    return reply({ error: "invalid_json" }, 400);
  }

  const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
  if (!REQUEST_ID_RE.test(requestId)) {
    return reply({ error: "invalid_request", detail: "request_id is required." }, 400);
  }
  const decline = body.decline === true;
  const values = decline ? null : readValues(body.values);
  if (decline === (body.values !== undefined) || (!decline && !values)) {
    return reply(
      { error: "invalid_values", detail: "Send either a secret value or decline." },
      400,
    );
  }

  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const resp = await client.resolveSecretRequest(
      requestId,
      decline ? { decline: true } : { values: values! },
    );
    return reply({
      ok: true,
      status: typeof resp?.status === "string" ? resp.status : decline ? "declined" : "fulfilled",
    });
  } catch (err) {
    if (err instanceof HermesApiError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return reply(
        {
          error: "api_error",
          detail: UPSTREAM_DETAIL[status] ?? "The secret could not be submitted.",
        },
        status,
      );
    }
    return reply({ error: "api_unreachable", detail: "The AI layer could not be reached." }, 502);
  }
}
