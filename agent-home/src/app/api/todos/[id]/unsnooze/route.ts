/**
 * POST /api/todos/:id/unsnooze — clear a to-do's snooze.
 *
 * Undo after Snooze sends the row's pre-snooze `until` and `notified_at`, so
 * the to-do returns exactly as it was; an empty body just wakes it now. The
 * upstream scopes the row to the caller, the same as snoozing it.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

type Restore = { until?: string | null; notified_at?: string | null };

function stamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const raw = (await req.json().catch(() => ({}))) as Restore | null;
  const body = raw && typeof raw === "object" ? raw : {};
  const restore: Restore = {};
  const until = stamp(body.until);
  const notifiedAt = stamp(body.notified_at);
  if (until !== undefined) restore.until = until;
  if (notifiedAt !== undefined) restore.notified_at = notifiedAt;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.unsnoozeTodo(id, restore));
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
