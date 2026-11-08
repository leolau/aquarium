import type { StatusSummary } from "@/types";

export type HealthVerdict = "ok" | "degraded" | "down" | "unknown";

/** Usage at or above these percentages turns the health pill amber. */
export const HEALTH_THRESHOLDS = { cpu: 90, mem: 90, disk: 90 } as const;

export const VERDICT_LABEL: Record<HealthVerdict, string> = {
  ok: "Healthy",
  degraded: "Degraded",
  down: "Offline",
  unknown: "Checking…",
};

export const VERDICT_DOT: Record<HealthVerdict, string> = {
  ok: "bg-[var(--color-success)]",
  degraded: "bg-[var(--color-warn)]",
  down: "bg-[var(--color-danger)]",
  unknown: "bg-[var(--color-muted)]",
};

/**
 * One verdict for the top bar, derived client-side from the status summary
 * (backend-spec §g). `reasons` say why it isn't "ok", in display order.
 */
export function healthVerdict({
  summary,
  stale,
  buildMismatch,
}: {
  summary: StatusSummary | null;
  stale: boolean;
  buildMismatch: boolean;
}): { verdict: HealthVerdict; reasons: string[] } {
  if (!summary) {
    return stale
      ? { verdict: "down", reasons: ["Can't reach the server — retrying"] }
      : { verdict: "unknown", reasons: [] };
  }
  const reasons: string[] = [];
  const over = (v: number | null, limit: number) => v !== null && v >= limit;
  if (over(summary.cpu_pct, HEALTH_THRESHOLDS.cpu))
    reasons.push(`CPU busy (${Math.round(summary.cpu_pct!)}%)`);
  if (over(summary.mem_pct, HEALTH_THRESHOLDS.mem))
    reasons.push(`Memory high (${Math.round(summary.mem_pct!)}%)`);
  if (over(summary.disk_pct, HEALTH_THRESHOLDS.disk))
    reasons.push(`Disk nearly full (${Math.round(summary.disk_pct!)}%)`);
  if (summary.upload_storage?.low) reasons.push("Upload storage is running low");
  if (buildMismatch) reasons.push("A new version is deployed — reload to update");
  if (stale) reasons.push("Readings are out of date — retrying");
  return { verdict: reasons.length ? "degraded" : "ok", reasons };
}
