/**
 * POST /api/models/set — assign a provider+model to the main slot or an
 * auxiliary task role. Forwards the body verbatim to the Python API
 * `POST /api/model/set` (scope/provider/model/task/confirm_expensive_model).
 *
 * The upstream response is replayed as-is: `confirm_required` is a 200, not
 * an error — the picker shows `confirm_message` and re-sends with
 * `confirm_expensive_model: true`. `stale_aux` likewise travels back so the
 * UI can warn about role slots still pinned to a different provider.
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
    provider?: string;
    model?: string;
    task?: string;
    base_url?: string;
    api_key?: string;
    confirm_expensive_model?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const scope = (body.scope ?? "").trim();
  if (scope !== "main" && scope !== "auxiliary") {
    return NextResponse.json(
      { error: "bad_scope", detail: "scope must be 'main' or 'auxiliary'" },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const data = await client.setModelAssignment({
      scope,
      provider: (body.provider ?? "").trim(),
      model: (body.model ?? "").trim(),
      task: body.task?.trim() || undefined,
      base_url: body.base_url?.trim() || undefined,
      api_key: body.api_key?.trim() || undefined,
      confirm_expensive_model: body.confirm_expensive_model === true,
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
