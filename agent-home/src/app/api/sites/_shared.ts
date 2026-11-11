/** Shared bits of the /api/sites/* proxies (site-to-schema, plan 2026-11-10-001). */
import { NextResponse } from "next/server";

export { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";

/** A JSON object body, or a 400 response. An empty body is ``{}``. */
export async function objectBody(
  req: Request,
): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  return body as Record<string, unknown>;
}
