/**
 * /api/activity/running — what is running right now (chats, project runs,
 * cards, cron jobs) for the shell's activity bar. The backend scopes every
 * row to the caller; this route only relays it.
 *
 * The bar is on every page and re-reads on mount, focus and a 15s poll, so
 * the upstream read is cached briefly per session (token hash + role in the
 * key — never served cross-principal). An upstream failure is a 502, never
 * an empty list, so the bar keeps its last good rows and dims instead of
 * vanishing.
 *
 * The same poll also carries the Scheduled button's summary
 * (`/api/activity/scheduled`), read in parallel under the same cache key. A
 * failed scheduled leg is `scheduled: null`, never a 502: the running rows
 * still render and only the button drops out.
 */
import { createHash } from "node:crypto";

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/session";
import type { ActivityRunning } from "@/types";

const CACHE_SECONDS = 10;

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const client = await apiClientForRequest();
  const read = async (): Promise<ActivityRunning> => {
    const [items, scheduled] = await Promise.all([
      client.activityRunning(),
      client.activityScheduled().catch(() => null),
    ]);
    return {
      items: Array.isArray(items) ? items : [],
      scheduled: scheduled && typeof scheduled === "object" ? scheduled : null,
    };
  };
  const token = (await readSession())?.hermesToken;
  try {
    const body = token
      ? await unstable_cache(
          read,
          [
            "activity-running",
            createHash("sha256").update(token).digest("hex"),
            canAdminister(principal) ? "admin" : "member",
          ],
          { revalidate: CACHE_SECONDS },
        )()
      : await read();
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
