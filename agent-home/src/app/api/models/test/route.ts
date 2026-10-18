/**
 * POST /api/models/test — fire one real minimal completion against a model
 * slot so the user can confirm a just-saved (or about-to-be-saved) config
 * actually works. Forwards {scope, task, provider, model, profile} to the
 * Python API `POST /api/model/test`, which never raises — failures come back
 * as {ok:false, error, error_type}.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";
import { profileFromBody } from "@/lib/chat/profile";

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: ADMIN_ONLY_DENIED },
      { status: 403 },
    );
  }
  let body: {
    scope?: string;
    task?: string;
    provider?: string;
    model?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const data = await client.testModel({
      scope: (body.scope ?? "main").trim(),
      task: body.task?.trim() || undefined,
      provider: body.provider?.trim() || undefined,
      model: body.model?.trim() || undefined,
    });
    return NextResponse.json(data);
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
