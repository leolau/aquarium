"use client";

import { useT } from "@/i18n/client";

/** `quota` on the tools response once 2.2 adds it (app_quota usage vs limits). */
export interface AppQuotaSummary {
  usage?: Partial<Record<"apps_registered" | "apps_running" | "ram_mb" | "disk_mb", number>>;
  limits?: { per_member?: Partial<Record<string, number | null>> };
}

const KEYS = ["apps_registered", "apps_running", "ram_mb", "disk_mb"] as const;

/** "2 of 3 local apps · 1 of 2 running · 412 MB of 1 GB" — hidden when unknown. */
export function QuotaStrip({ quota }: { quota?: AppQuotaSummary | null }) {
  const t = useT("tools");
  const usage = quota?.usage;
  if (!usage) return null;
  const limits = quota?.limits?.per_member ?? {};
  const parts = KEYS.filter((k) => typeof usage[k] === "number").map((k) => {
    const limit = limits[k];
    return limit === null || limit === undefined
      ? t(`quota.${k}.unlimited`, { used: usage[k] ?? 0 })
      : t(`quota.${k}.of`, { used: usage[k] ?? 0, limit });
  });
  if (!parts.length) return null;
  return (
    <p data-component="QuotaStrip" className="text-xs text-[var(--color-muted)]">
      {parts.join(" · ")}
    </p>
  );
}
