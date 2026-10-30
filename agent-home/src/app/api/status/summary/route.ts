/**
 * /api/status/summary — one-shot aggregate for the shell status strip:
 * CPU/memory/disk, the bound profile's 30-day token usage, box-wide active
 * conversations, running kanban cards, and the cron job count. Each leg is
 * independent — a failed read yields a null field, never a failed strip.
 *
 * The strip is on every page and re-reads on mount, focus and a 30s poll,
 * so the upstream fan-out is cached briefly per session (token hash +
 * role in the key — never served cross-principal).
 */
import { createHash } from "node:crypto";

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import type { HermesApiClient } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { readSession } from "@/lib/auth/session";
import type { StatusSummary } from "@/types";

const CACHE_SECONDS = 15;

type Metrics = Omit<StatusSummary, "build">;

async function collect(client: HermesApiClient, admin: boolean): Promise<Metrics> {
  const [stats, usage, capacity, cron, running, uploadStorage] = await Promise.all([
    client.systemStats().catch(() => null),
    client.usageAnalytics(30).catch(() => null),
    client.capacity().catch(() => null),
    client.cronJobs().catch(() => null),
    client.projectsRunningCards().catch(() => null),
    admin
      ? Promise.resolve()
          .then(() => client.uploadStorage())
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    cpu_pct: stats?.cpu_percent ?? null,
    mem_pct: stats?.memory?.percent ?? null,
    disk_pct: stats?.disk?.percent ?? null,
    tokens_month: usage?.totals
      ? {
          input: usage.totals.total_input ?? 0,
          output: usage.totals.total_output ?? 0,
          cost_usd:
            usage.totals.total_actual_cost ??
            usage.totals.total_estimated_cost ??
            null,
        }
      : null,
    active_conversations: capacity?.indicators.active_conversations ?? null,
    running_cards: running?.running_cards ?? null,
    cron_total: cron?.length ?? 0,
    cron_enabled: cron ? cron.filter((j) => j.enabled !== false).length : 0,
    upload_storage: uploadStorage,
    collected_at: Date.now() / 1000,
  };
}

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const client = await apiClientForRequest();
  const admin = canAdminister(principal);
  const token = (await readSession())?.hermesToken;
  const metrics = token
    ? await unstable_cache(
        () => collect(client, admin),
        [
          "status-summary",
          createHash("sha256").update(token).digest("hex"),
          admin ? "admin" : "member",
        ],
        { revalidate: CACHE_SECONDS },
      )()
    : await collect(client, admin);
  const summary: StatusSummary = {
    ...metrics,
    // The SHA this build was compiled from — the strip compares it to the
    // browser bundle's own SHA to flag a stale post-deploy bundle.
    build: process.env.NEXT_PUBLIC_HERMES_BUILD ?? null,
  };
  return NextResponse.json(summary);
}
