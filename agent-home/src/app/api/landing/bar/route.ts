/**
 * /api/landing/bar — one poll for the landing top bar: a health verdict
 * (system stats + upload storage), this month's tokens, what is running or
 * waiting (activity), and the needs-you count. Each leg is independent: a
 * failed read degrades its field, and only a bar with every leg down is a
 * 502 (so the client keeps its last good bar).
 *
 * `?build=<sha>` (optional) is the browser bundle's build; it is compared
 * with this server's to flag a stale post-deploy bundle.
 */
import { createHash } from "node:crypto";

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import type { HermesApiClient } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/session";
import type { LandingBarResponse, NeedsYouResponse } from "@/types/landing";

const CACHE_SECONDS = 10;
/** A resource at or above this percentage marks the box degraded. */
const HOT_PCT = 90;

interface Legs {
  cpu_pct: number | null;
  mem_pct: number | null;
  disk_pct: number | null;
  stats_ok: boolean;
  low_storage: boolean;
  tokens_month: number | null;
  cron_enabled: number | null;
  running: number | null;
  waiting: number | null;
  needs_you: { count: number; blocking: number } | null;
}

async function collect(client: HermesApiClient, admin: boolean): Promise<Legs> {
  const [stats, usage, cron, uploadStorage, activity, needs] = await Promise.all([
    client.systemStats().catch(() => null),
    client.usageAnalytics(30).catch(() => null),
    client.cronJobs().catch(() => null),
    admin
      ? Promise.resolve()
          .then(() => client.uploadStorage())
          .catch(() => null)
      : Promise.resolve(null),
    client.activityRunning().catch(() => null),
    client.request<NeedsYouResponse>("/api/needs-you?include=count").catch(() => null),
  ]);
  const items = Array.isArray(activity) ? activity : null;
  return {
    cpu_pct: stats?.cpu_percent ?? null,
    mem_pct: stats?.memory?.percent ?? null,
    disk_pct: stats?.disk?.percent ?? null,
    stats_ok: stats != null,
    low_storage: Boolean(uploadStorage?.low),
    tokens_month: usage?.totals
      ? (usage.totals.total_input ?? 0) + (usage.totals.total_output ?? 0)
      : null,
    cron_enabled: cron ? cron.filter((j) => j.enabled !== false).length : null,
    running: items ? items.filter((i) => i.status === "running").length : null,
    waiting: items ? items.filter((i) => i.status === "waiting").length : null,
    needs_you: needs
      ? {
          count: typeof needs.count === "number" ? needs.count : 0,
          blocking: needs.by_severity?.blocking ?? 0,
        }
      : null,
  };
}

function verdict(legs: Legs): LandingBarResponse["health"]["verdict"] {
  if (!legs.stats_ok) return "degraded";
  const hot = [legs.cpu_pct, legs.mem_pct, legs.disk_pct].some(
    (p) => typeof p === "number" && p >= HOT_PCT,
  );
  return hot || legs.low_storage ? "degraded" : "ok";
}

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const client = await apiClientForRequest();
  const admin = canAdminister(principal);
  const token = (await readSession())?.hermesToken;
  const legs = token
    ? await unstable_cache(
        () => collect(client, admin),
        [
          "landing-bar",
          createHash("sha256").update(token).digest("hex"),
          admin ? "admin" : "member",
        ],
        { revalidate: CACHE_SECONDS },
      )()
    : await collect(client, admin);
  if (!legs.stats_ok && legs.running === null && legs.needs_you === null) {
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
  const clientBuild = new URL(req.url).searchParams.get("build");
  const serverBuild = process.env.NEXT_PUBLIC_HERMES_BUILD ?? null;
  const body: LandingBarResponse = {
    health: {
      verdict: verdict(legs),
      cpu_pct: legs.cpu_pct,
      mem_pct: legs.mem_pct,
      disk_pct: legs.disk_pct,
      build_mismatch: Boolean(clientBuild && serverBuild && clientBuild !== serverBuild),
      low_storage: legs.low_storage,
    },
    usage: { tokens_month: legs.tokens_month },
    work: {
      running: legs.running ?? 0,
      waiting: legs.waiting ?? 0,
      cron_enabled: legs.cron_enabled ?? 0,
    },
    needs_you: legs.needs_you ?? { count: 0, blocking: 0 },
    collected_at: Date.now() / 1000,
  };
  return NextResponse.json(body);
}
