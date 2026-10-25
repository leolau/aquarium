/**
 * /api/tools/apps/[name]/secrets — PUT sets or removes ONE secret of a local
 * app (FG-33 §3.6, P8-2 2.7). Body `{mode, name, value}` or
 * `{mode, name, delete: true}`; forwarded to the Python API's
 * `PUT /api/tools/{name}/secrets`, which checks the caller may act on the app
 * and calls the root helper's `set-secret`.
 *
 * The value only passes through: it is never logged, never put in a URL and
 * never returned. The answer carries secret names only.
 */
import { NextResponse } from "next/server";

import {
  type AppSecretsResult,
  isAppMode,
  isAppSlug,
  secretNameProblem,
  secretValueProblem,
} from "@/components/apps-secrets/rules";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

const NO_STORE = { "Cache-Control": "no-store" };

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function bad(error: string, detail: string): NextResponse {
  return reply({ error, detail }, 400);
}

/** Upstream text with any copy of the value masked, in case a layer echoed it. */
function scrub(text: string, value: string | undefined): string {
  return value ? text.split(value).join("[redacted]") : text;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return reply({ error: "unauthenticated" }, 401);
  if (principal.role === "viewer") {
    return reply(
      { error: "forbidden", detail: "Viewers cannot change app secrets." },
      403,
    );
  }
  const { name: slug } = await params;
  if (!isAppSlug(slug)) return bad("bad_app", "That is not an app name.");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("bad_json", "Send a JSON object.");
  }
  const { mode, name, value } = body;
  const remove = body.delete === true;
  if (!isAppMode(mode)) return bad("bad_mode", "mode must be dev or prod.");
  if (typeof name !== "string" || secretNameProblem(name)) {
    return bad(
      "bad_name",
      "Secret names look like MY_API_KEY and must not be reserved (APP_*, DATABASE_URL*, NEXT_PUBLIC_*, NODE_*, PORT …).",
    );
  }
  if (remove && value !== undefined) {
    return bad("bad_body", "Give either value or delete, not both.");
  }
  if (!remove && (typeof value !== "string" || secretValueProblem(value))) {
    return bad("bad_value", "The value must be non-empty text of at most 8 KB.");
  }
  const secret = remove ? undefined : (value as string);
  const idempotencyKey = request.headers.get("idempotency-key");

  try {
    const client = await apiClientForRequest();
    const out = await client.request<Partial<AppSecretsResult> | undefined>(
      `/api/tools/${encodeURIComponent(slug)}/secrets`,
      {
        method: "PUT",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        json: remove ? { mode, name, delete: true } : { mode, name, value: secret },
      },
    );
    const names = Array.isArray(out?.secret_names)
      ? out.secret_names.filter((n): n is string => typeof n === "string")
      : [];
    const result: AppSecretsResult = {
      mode,
      secret_names: names,
      restart_needed: out?.restart_needed === true,
    };
    return reply(result);
  } catch (err) {
    if (err instanceof HermesApiError) {
      return reply(
        { error: "api_error", detail: scrub(err.message, secret) },
        err.status,
      );
    }
    return reply(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      502,
    );
  }
}
