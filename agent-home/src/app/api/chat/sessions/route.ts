/**
 * GET /api/chat/sessions — BFF conversation list (FG-20 Wave C1). Forwards to
 * the Python API `GET /api/sessions` (recent-first) under the bridged C1
 * principal so the mobile chat list can refresh after a send.
 *
 * Defaults to excluding cron sessions (unchanged behaviour for existing
 * callers like the unread-count badge and the archived-conversations modal,
 * neither of which want scheduler noise). Pass `exclude_sources=` (empty) to
 * include everything — `ChatPane`'s own refresh does this now that the
 * session strip groups cron sessions into their own "Scheduled" row instead
 * of hiding them.
 *
 * `limit` is capped at one 200-row page; `limit=all` reads every page, which
 * is what the strip uses so no category silently loses its older entries.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(request.url);
  const raw = url.searchParams.get("archived");
  const archived: "exclude" | "only" | "include" | undefined =
    raw === "only" || raw === "include" || raw === "exclude" ? raw : undefined;
  // `Number(null)` is 0, which would clamp to a one-session list — a refresh
  // without an explicit limit must not truncate to the current session.
  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit !== null && Number.isFinite(Number(rawLimit))
      ? Math.min(200, Math.max(1, Math.floor(Number(rawLimit))))
      : undefined;
  // `null` (param absent) keeps the historical default of excluding cron;
  // an explicit (even empty) value lets a caller opt in to seeing it.
  const rawExcludeSources = url.searchParams.get("exclude_sources");
  const excludeSources =
    rawExcludeSources === null ? "cron" : rawExcludeSources || undefined;
  const filters = {
    excludeSources,
    order: "recent" as const,
    archived,
    tags: url.searchParams.get("tags") ?? undefined,
    excludeTags: url.searchParams.get("exclude_tags") ?? undefined,
    tagMatch: url.searchParams.get("tag_match") ?? undefined,
    pinned: url.searchParams.get("pinned") === "only" ? ("only" as const) : undefined,
  };
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    const data =
      rawLimit === "all"
        ? await client.allSessions(filters)
        : await client.sessions({ ...filters, limit });
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
