/**
 * GET /api/todos — BFF listing of the to-dos page.
 * POST /api/todos — a to-do the user wrote themselves.
 *
 * Forwards to the Python `/api/registry/todos` under the bridged C1 principal,
 * which scopes the rows. Snoozed to-dos stay hidden unless asked for: a snooze
 * the list ignores is not a snooze.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.todos({
        q: params.get("q") ?? undefined,
        stage: params.get("stage") ?? undefined,
        priority: params.get("priority") ?? undefined,
        source_kind: params.get("source_kind") ?? undefined,
        source_ref: params.get("source_ref") ?? undefined,
        due_before: params.get("due_before") ?? undefined,
        include_snoozed: params.get("include_snoozed") === "true",
        limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        cursor: params.get("cursor") ?? undefined,
      }),
    );
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

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    description?: string;
    priority?: string;
    due_at?: string | null;
    source_kind?: string;
    source_ref?: string;
  };
  const title = (body.title ?? "").trim();
  if (!title) {
    return NextResponse.json(
      { error: "invalid_request", detail: "A to-do needs a title." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.createTodo({
        title,
        description: body.description,
        priority: body.priority,
        due_at: body.due_at ?? null,
        // Only an arrival link is forwarded; every other origin is the server's call.
        ...(body.source_kind === "inbound" && typeof body.source_ref === "string" && body.source_ref
          ? { source_kind: "inbound", source_ref: body.source_ref }
          : {}),
      }),
    );
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
