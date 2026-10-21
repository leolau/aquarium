/**
 * GET /api/models/fallback — the backup models, in the order they are
 * tried when the main model fails. PUT replaces the whole list
 * (`{ providers: [{ provider, model }] }`); owners/admins only.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";
import type { FallbackModel } from "@/types";

function errorBody(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json({ error: "api_error", detail: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.fallbackModels());
  } catch (err) {
    return errorBody(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden", detail: ADMIN_ONLY_DENIED }, { status: 403 });
  }
  let body: { providers?: unknown; task?: unknown; profile?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request", detail: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.providers)) {
    return NextResponse.json({ error: "bad_request", detail: "providers must be a list." }, { status: 400 });
  }
  const providers: FallbackModel[] = [];
  for (const raw of body.providers) {
    const e = raw as { provider?: unknown; model?: unknown };
    if (typeof e?.provider !== "string" || typeof e?.model !== "string") {
      return NextResponse.json(
        { error: "bad_request", detail: "Each backup needs a provider and a model." },
        { status: 400 },
      );
    }
    providers.push({ provider: e.provider, model: e.model });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const task = typeof body.task === "string" && body.task ? body.task : undefined;
    return NextResponse.json(await client.setFallbackModels(providers, task));
  } catch (err) {
    return errorBody(err);
  }
}
