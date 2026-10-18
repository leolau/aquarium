/**
 * /api/status/summary — one-shot aggregate for the shell status strip:
 * CPU/memory/disk, the bound profile's 30-day token usage, box-wide active
 * conversations, running kanban cards, and the cron job count. Each leg is
 * independent — a failed read yields a null field, never a failed strip.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import type { StatusSummary } from "@/types";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const client = await apiClientForRequest();
  const admin = canAdminister(principal);
  const [stats, usage, capacity, cron, projects, uploadStorage] = await Promise.all([
    client.systemStats().catch(() => null),
    client.usageAnalytics(30).catch(() => null),
    client.capacity().catch(() => null),
    client.cronJobs().catch(() => null),
    client.projects({ status: "active", limit: 100 }).catch(() => null),
    admin
      ? Promise.resolve()
          .then(() => client.uploadStorage())
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const summary: StatusSummary = {
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
    running_cards: projects
      ? projects.items.reduce((n, p) => n + (p.progress.cards.running ?? 0), 0)
      : null,
    cron_total: cron?.length ?? 0,
    cron_enabled: cron ? cron.filter((j) => j.enabled !== false).length : 0,
    // The SHA this build was compiled from — the strip compares it to the
    // browser bundle's own SHA to flag a stale post-deploy bundle.
    build: process.env.NEXT_PUBLIC_HERMES_BUILD ?? null,
    upload_storage: uploadStorage,
    collected_at: Date.now() / 1000,
  };
  return NextResponse.json(summary);
}
