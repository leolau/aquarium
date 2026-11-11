/**
 * GET/POST /api/secret-links/[token] — FG-37 one-time secret links.
 * **Unauthenticated on purpose**: the person opening the link has no session;
 * the token sent into their own chat is the credential. Forwards to the Python
 * API, which throttles per IP and per token and answers the same 404 for an
 * unknown, used or expired link. Neither the token nor the body is ever
 * logged, and every response is `no-store` / `no-referrer`.
 */
import { NextResponse } from "next/server";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { callerIp } from "@/lib/api/callerIp";
import type { SecretLinkSubmit } from "@/types";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const MAX_VALUE = 8192;

type Ctx = { params: Promise<{ token: string }> };

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

const notFound = () => reply({ ok: false, error: "not_found" }, 404);

function failure(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    if (err.status === 404) return notFound();
    if (err.status === 429) return reply({ ok: false, error: "rate_limited" }, 429);
    if (err.status === 400 || err.status === 413) return reply({ ok: false, error: "invalid" }, 400);
  }
  return reply({ ok: false, error: "unavailable" }, 502);
}

/** `{values}` with string fields only, or `{decline: true}`; else null. */
function parseSubmit(raw: unknown): SecretLinkSubmit | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { values?: unknown; decline?: unknown };
  if (body.decline === true) return { decline: true };
  if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return null;
  const values: Record<string, string> = {};
  for (const [key, val] of Object.entries(body.values as Record<string, unknown>)) {
    if (typeof val !== "string" || val.length > MAX_VALUE) return null;
    values[key] = val;
  }
  return Object.keys(values).length ? { values } : null;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) return notFound();
  try {
    return reply(await new HermesApiClient().secretLinkInfo(token, callerIp(request)));
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const { token } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return reply({ ok: false, error: "invalid" }, 400);
  }
  const body = parseSubmit(raw);
  raw = undefined;
  if (!body) return reply({ ok: false, error: "invalid" }, 400);
  if (!TOKEN_RE.test(token)) return notFound();
  try {
    const result = await new HermesApiClient().submitSecretLink(token, body, callerIp(request));
    // Only the status and the secret's name go back to the browser.
    return reply({ ok: true, status: result.status, ...(result.name ? { name: result.name } : {}) });
  } catch (err) {
    return failure(err);
  }
}
