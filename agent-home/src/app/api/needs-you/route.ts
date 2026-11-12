/**
 * /api/needs-you — everything waiting on the caller (project checkpoints,
 * card waits/approvals, outputs to accept, chat/webview approvals, to-dos,
 * profile suggestions) as one `NeedsYouResponse`. `?include=count` returns
 * the counts with an empty `items`. The backend scopes every row to the
 * caller; this route only relays it.
 *
 * Polled every 15s from the landing page (and on focus), so the upstream
 * read is cached briefly per session (token hash + role in the key — never
 * served cross-principal). An upstream failure is a 502, never an empty
 * list, so the client keeps its last good items. An upstream 401 (the
 * session's token expired) stays a 401.
 */
import { createHash } from "node:crypto";

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import { isUpstreamUnauthenticated } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/session";
import type { NeedsYouResponse, NeedsYouSeverity } from "@/types/landing";

const CACHE_SECONDS = 5;
const SEVERITIES: NeedsYouSeverity[] = ["blocking", "approval", "review", "fyi"];

function normalize(raw: Partial<NeedsYouResponse> | null | undefined): NeedsYouResponse {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const by = raw?.by_severity ?? ({} as Partial<Record<NeedsYouSeverity, number>>);
  return {
    items,
    count: typeof raw?.count === "number" ? raw.count : items.length,
    by_severity: Object.fromEntries(
      SEVERITIES.map((s) => [s, typeof by[s] === "number" ? by[s] : 0]),
    ) as Record<NeedsYouSeverity, number>,
    collected_at: typeof raw?.collected_at === "number" ? raw.collected_at : Date.now() / 1000,
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const countOnly = new URL(req.url).searchParams.get("include") === "count";
  const client = await apiClientForRequest();
  const read = () =>
    client.request<NeedsYouResponse>(
      countOnly ? "/api/needs-you?include=count" : "/api/needs-you",
    );
  const token = (await readSession())?.hermesToken;
  try {
    const raw = token
      ? await unstable_cache(
          read,
          [
            "needs-you",
            createHash("sha256").update(token).digest("hex"),
            canAdminister(principal) ? "admin" : "member",
            countOnly ? "count" : "items",
          ],
          { revalidate: CACHE_SECONDS },
        )()
      : await read();
    return NextResponse.json(normalize(raw));
  } catch (err) {
    if (isUpstreamUnauthenticated(err)) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
