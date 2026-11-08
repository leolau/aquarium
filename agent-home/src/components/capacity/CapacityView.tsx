"use client";

import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui/InfoTip";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import type { CapacityResponse, CpuHistory } from "@/types";

const TONE: Record<CapacityResponse["state"], string> = {
  comfortable: "text-[var(--color-success)]",
  watch: "text-[var(--color-warn-text)]",
  constrained: "text-[var(--color-danger)]",
};

const VERDICT_HINT: Record<CapacityResponse["state"], string> = {
  comfortable: "Room for more people and more profiles.",
  watch: "A bound is approaching — plan, don't panic.",
  constrained: "Actively degrading — act now.",
};

function gb(mb: number | null): string {
  return mb === null ? "unknown" : `${(mb / 1024).toFixed(1)} GB`;
}

function seconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}s`;
}

/**
 * FG-31 — where the box stands, on the surface the owner actually uses (D20).
 *
 * Two things are deliberate. The verdict always shows **the bound that produced
 * it**, because "78%" tells the owner nothing about what to do while "memory,
 * driven by 9 concurrent conversations" does. And when the binding bound cannot
 * be moved by hardware, that is said before any recommendation — the SQLite
 * single-writer bound is serialisation, so a bigger box would be money spent
 * for no change.
 */
export function CapacityView({ capacity }: { capacity: CapacityResponse }) {
  const t = useT("settings");
  const ind = capacity.indicators;
  const binding = capacity.binding_constraint;
  const rows: { label: string; value: string; tip?: ReactNode }[] = [
    {
      label: "Active conversations",
      value:
        ind.cap_box_wide === null
          ? `${ind.active_conversations} (no cap set)`
          : `${ind.active_conversations} / ~${ind.cap_box_wide}`,
    },
    {
      label: "Memory available",
      value: ind.total_mb ? `${gb(ind.available_mb)} of ${gb(ind.total_mb)}` : gb(ind.available_mb),
    },
    {
      label: "Storage",
      value:
        ind.disk_pct === null || ind.disk_used_mb === null
          ? "unknown"
          : `${gb(ind.disk_used_mb)} of ${gb(ind.disk_total_mb)} used (${Math.round(ind.disk_pct * 100)}%)`,
    },
    {
      label: "CPU load",
      value:
        ind.cpu_load1 === null
          ? "unknown"
          : `${ind.cpu_load1.toFixed(1)} on ${ind.cpu_count ?? "?"} cpu(s)` +
            (ind.cpu_percent !== null
              ? ` · ${Math.round(ind.cpu_percent)}% now`
              : ""),
    },
    {
      label: "Write-lock waits",
      tip: <InfoTip label={t("capacity.tip.writeLockLabel")}>{t("capacity.tip.writeLock")}</InfoTip>,
      value:
        ind.write_lock_waits_per_hour === null
          ? "unknown"
          : `${ind.write_lock_waits_per_hour.toFixed(1)} / hour`,
    },
    {
      label: "Reply latency",
      tip: <InfoTip label={t("capacity.tip.latencyLabel")}>{t("capacity.tip.latency")}</InfoTip>,
      value:
        ind.turn_samples === 0
          ? "no turns yet"
          : `p50 ${seconds(ind.turn_p50_s)} · p95 ${seconds(ind.turn_p95_s)}`,
    },
    { label: "Profiles", value: `${ind.profile_count}` },
  ];

  return (
    <div data-component="CapacityView" className="flex flex-col gap-4">
      <section
        data-component="CapacityVerdict"
        className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:p-5"
      >
        <p className={`flex items-center gap-2 text-lg font-semibold ${TONE[capacity.state]}`}>
          {capacity.state === "comfortable" ? (
            <CheckIcon size={20} aria-hidden />
          ) : (
            <AlertIcon size={20} aria-hidden />
          )}
          Headroom: {capacity.state}
        </p>
        <p className="text-sm text-[var(--color-muted)]">{capacity.summary}</p>
        <p className="text-sm text-[var(--color-muted)]">{VERDICT_HINT[capacity.state]}</p>
        {binding && capacity.state !== "comfortable" ? (
          <p data-component="CapacityBinding" className="text-sm">
            <span className="font-medium">{binding.name}</span> — {binding.reason}
          </p>
        ) : null}
        {binding && !binding.hardware_helps && capacity.state !== "comfortable" ? (
          <p
            data-component="CapacityHardwareWarning"
            className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          >
            A bigger box will not fix this one.
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      <section
        data-component="CapacityIndicators"
        className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <h2 className="text-sm font-medium">The reading</h2>
        <dl className="flex flex-col gap-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <dt className="flex items-center gap-1 text-[var(--color-muted)]">
                {row.label}
                {row.tip}
              </dt>
              <dd className="min-w-0 break-words text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
        {Object.keys(ind.per_profile).length > 1 ? (
          <p data-component="CapacityPerProfile" className="text-xs text-[var(--color-muted)]">
            Per profile:{" "}
            {Object.entries(ind.per_profile)
              .map(([name, count]) => `${name} ${count}`)
              .join(" · ")}
          </p>
        ) : null}
        {capacity.unavailable.length > 0 ? (
          <p data-component="CapacityUnavailable" className="text-xs text-[var(--color-muted)]">
            Not measured: {capacity.unavailable.join(", ")}
          </p>
        ) : null}
      </section>

      <div className="flex flex-col gap-4">
      <CpuHistorySection history={capacity.cpu_history} />

      {capacity.recommendations.length > 0 ? (
        <section
          data-component="CapacityRecommendations"
          className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-sm font-medium">What to do, cheapest first</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {capacity.recommendations.map((rec) => (
              <li key={rec} className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2">
                {rec}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      </div>
      </div>
    </div>
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function hourLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * CPU utilization history: a 24-bucket bar chart plus the busiest sampled
 * minute over 24h / 7d / 30d. Bars show each hour's average; the title holds
 * the exact figure so the graph stays readable at 24 buckets.
 */
function CpuHistorySection({ history }: { history: CpuHistory | null }) {
  const hourly = history?.hourly ?? [];
  const hasData = hourly.some((p) => p.avg_pct !== null || p.max_pct !== null);
  return (
    <section
      data-component="CapacityCpuHistory"
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-sm font-medium">CPU utilization</h2>
      {hasData ? (
        <>
          <div
            data-component="CpuHistoryChart"
            role="img"
            aria-label="CPU utilization over the past 24 hours"
            className="flex h-24 items-end gap-px"
          >
            {hourly.map((point) => {
              const avg = point.avg_pct ?? 0;
              return (
                <div
                  key={point.ts}
                  title={`${hourLabel(point.ts)} — avg ${pct(point.avg_pct)}, peak ${pct(point.max_pct)}`}
                  className="flex-1 rounded-sm bg-[var(--color-accent)]"
                  style={{ height: `${Math.max(avg, 2)}%`, opacity: point.avg_pct === null ? 0.15 : 1 }}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-[var(--color-muted)]">
            <span>{hourly.length > 0 ? hourLabel(hourly[0].ts) : ""}</span>
            <span>24h ago → now</span>
          </div>
        </>
      ) : (
        <p data-component="CpuHistoryEmpty" className="text-sm text-[var(--color-muted)]">
          No CPU history yet — the dashboard samples once a minute, so the graph fills in over the first day.
        </p>
      )}
      <dl data-component="CpuHistoryPeaks" className="flex flex-col gap-2 text-sm">
        {(
          [
            ["Busiest minute, 24h", history?.max_24h ?? null],
            ["Busiest minute, 7d", history?.max_7d ?? null],
            ["Busiest minute, 30d", history?.max_30d ?? null],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--color-muted)]">{label}</dt>
            <dd>{pct(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
