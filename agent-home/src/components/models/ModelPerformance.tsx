"use client";

import { useMemo, useState } from "react";

import { callDurationLabel } from "@/components/projects/format";
import { Pill } from "@/components/ui/Pill";
import type {
  ModelPerfMonth,
  ModelPerformanceEntry,
  ModelsPerformanceResponse,
} from "@/types";

/** Distinct stack colors per model in the monthly history chart. The first
 * tracks the theme accent so the busiest model reads as the page's own. */
const MODEL_COLORS = [
  "var(--color-accent)",
  "#60a5fa",
  "#c084fc",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#22d3ee",
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0";
}

/** "4.1s" / "820ms" / "5m 16s" — latency labels for the stat grid. */
const formatMs = callDurationLabel;

type HistoryMetric = "tokens" | "calls" | "failed" | "response time";
const HISTORY_METRICS: HistoryMetric[] = ["tokens", "calls", "failed", "response time"];

/** The stacked-bar value of one month×model cell for `metric`. */
function cellValue(m: ModelPerfMonth | undefined, metric: HistoryMetric): number {
  if (!m) return 0;
  if (metric === "tokens") return m.tokens;
  if (metric === "calls") return m.calls;
  if (metric === "failed") return m.failures ?? 0;
  return m.avg_ms ?? 0;
}

function formatMetric(v: number, metric: HistoryMetric): string {
  if (metric === "tokens") return formatTokens(v);
  if (metric === "response time") return `avg ${formatMs(v)}`;
  return v.toLocaleString();
}

function roleLabel(role: string): string {
  return role === "main" ? "main" : role.replace(/_/g, " ");
}

function roleTone(role: string): "accent" | "warning" | "muted" {
  if (role === "main") return "accent";
  if (role === "backup") return "warning";
  return "muted";
}

/** "key rejected (401)" — plain words for the most common failure causes. */
function failureLabel(code: number | null, errorType: string): string {
  const word =
    code === 401 ? "key rejected"
      : code === 402 ? "out of credit"
        : code === 403 ? "access denied"
          : code === 404 ? "model not found"
            : code === 429 ? "rate limited or busy"
              : code != null && code >= 500 ? "provider error"
                : /timeout/i.test(errorType) ? "timed out"
                  : /connection/i.test(errorType) ? "couldn't connect"
                    : errorType || "error";
  return code != null ? `${word} (${code})` : word;
}

function monthLabel(month: string): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[Number(month.split("-")[1]) - 1] ?? month;
}

function shortDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Seven fixed day columns ending today; missing days render empty. */
function DailyBars({ entry }: { entry: ModelPerformanceEntry }) {
  const days = useMemo(() => {
    const out: string[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      out.push(
        new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10),
      );
    }
    return out;
  }, []);
  const byDay = useMemo(
    () => new Map(entry.daily.map((d) => [d.date, d])),
    [entry.daily],
  );
  const maxCalls = Math.max(
    1,
    ...days.map((d) => byDay.get(d)?.calls ?? 0),
  );
  return (
    <div>
      <div
        data-component="PerfDailyBars"
        role="img"
        aria-label={`${entry.model} calls per day, last 7 days`}
        className="flex h-10 items-end gap-1"
      >
        {days.map((day) => {
          const d = byDay.get(day);
          const calls = d?.calls ?? 0;
          const failed = d?.failures ?? 0;
          const label = `${shortDay(day)} — ${calls} calls${failed ? ` · ${failed} failed` : ""
            }${d?.avg_ms != null ? ` · avg ${formatMs(d.avg_ms)}` : ""}`;
          return (
            <div
              key={day}
              title={label}
              className="relative flex-1 rounded-sm bg-[var(--color-accent)]"
              style={{
                height: `${Math.max((calls / maxCalls) * 100, calls ? 8 : 2)}%`,
                opacity: calls ? 1 : 0.15,
              }}
            >
              {failed > 0 ? (
                <div
                  className="absolute inset-x-0 top-0 rounded-sm bg-[var(--color-warn,#f59e0b)]"
                  style={{ height: `${Math.max((failed / calls) * 100, 15)}%` }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--color-muted)]">
        <span>{shortDay(days[0])}</span>
        <span>calls/day</span>
        <span>today</span>
      </div>
    </div>
  );
}

function ModelPerfCard({ entry }: { entry: ModelPerformanceEntry }) {
  const lat = entry.latency_ms;
  const failed = entry.failures > 0;
  const rate = entry.success_rate == null
    ? null
    : `${(entry.success_rate * 100).toFixed(1)}%`;
  return (
    <div
      data-component="ModelPerfCard"
      className="border-b border-[var(--color-border)] px-3 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 text-sm font-medium">{entry.model}</span>
        {entry.caller_roles.map((r) => (
          <Pill key={r} tone={roleTone(r)}>
            {roleLabel(r)}
          </Pill>
        ))}
        {entry.provider ? (
          <span className="ml-auto text-[11px] text-[var(--color-muted)]">
            {entry.provider}
          </span>
        ) : null}
      </div>
      {entry.served_as?.length ? (
        <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
          {entry.provider || "The provider"}&apos;s replies name it {entry.served_as.join(", ")}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
        <div>
          <dt className="text-[11px] text-[var(--color-muted)]">Calls</dt>
          <dd>
            {entry.calls.toLocaleString()}
            {rate ? <span className="text-[var(--color-muted)]"> · {rate} ok</span> : null}
            {failed ? (
              <span className="text-[var(--color-warn-text)]">
                {" "}· {entry.failures} failed
                {entry.failure_reasons?.length
                  ? `: ${entry.failure_reasons
                    .slice(0, 2)
                    .map((f) => failureLabel(f.status_code, f.error_type))
                    .join(", ")}`
                  : ""}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-[var(--color-muted)]">Response time</dt>
          <dd>
            avg {formatMs(lat.avg)} · p95 {formatMs(lat.p95)}
            <span className="block text-[11px] text-[var(--color-muted)]">
              min {formatMs(lat.min)} · max {formatMs(lat.max)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-[var(--color-muted)]">Tokens</dt>
          <dd>
            {formatTokens(entry.tokens.input)} in · {formatTokens(entry.tokens.output)} out
            {entry.tokens.cache_read ? (
              <span className="block text-[11px] text-[var(--color-muted)]">
                {formatTokens(entry.tokens.cache_read)} cached
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-[var(--color-muted)]">Cost</dt>
          <dd>{formatCost(entry.cost_usd)}</dd>
        </div>
      </dl>
      <div className="mt-2">
        <DailyBars entry={entry} />
      </div>
    </div>
  );
}

/**
 * Per-model bars per month. Tokens, calls and failed calls stack; response
 * time puts each model's monthly average side by side (averages don't add).
 * The table under the chart has every month×model's calls, failures and
 * min/avg/max response time.
 */
function HistoryChart({
  monthly,
  months,
}: {
  monthly: ModelsPerformanceResponse["monthly"];
  months: number;
}) {
  const [metric, setMetric] = useState<HistoryMetric>("tokens");
  const grouped = metric === "response time";
  const monthKeys = useMemo(() => {
    const keys = [...new Set(monthly.map((m) => m.month))].sort();
    return keys.slice(-months);
  }, [monthly, months]);
  const models = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of monthly) {
      seen.set(m.model, (seen.get(m.model) ?? 0) + m.tokens + m.calls);
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model], i) => ({ model, color: MODEL_COLORS[i % MODEL_COLORS.length] }));
  }, [monthly]);
  const cell = useMemo(() => {
    const map = new Map<string, (typeof monthly)[number]>();
    for (const m of monthly) map.set(`${m.month}${m.model}`, m);
    return map;
  }, [monthly]);
  const monthTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const key of monthKeys) {
      map.set(
        key,
        models.reduce(
          (sum, { model }) => {
            const v = cellValue(cell.get(`${key}${model}`), metric);
            return grouped ? Math.max(sum, v) : sum + v;
          },
          0,
        ),
      );
    }
    return map;
  }, [monthKeys, models, cell, metric, grouped]);
  const maxTotal = Math.max(1, ...monthTotals.values());
  if (monthKeys.length === 0) return null;
  return (
    <section data-component="ModelPerfHistory">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          History · past {monthKeys.length} {monthKeys.length === 1 ? "month" : "months"}
        </h2>
        <div className="ml-auto flex overflow-hidden rounded-full border border-[var(--color-border)] text-[11px]">
          {HISTORY_METRICS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className={`px-2.5 py-0.5 ${metric === m
                  ? "bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                  : "text-[var(--color-muted)]"
                }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div
          role="img"
          aria-label={`${metric} per month by model`}
          className="flex h-28 items-end gap-2"
        >
          {monthKeys.map((key) => {
            const total = monthTotals.get(key) ?? 0;
            if (grouped) {
              return (
                <div key={key} className="flex h-full min-w-0 flex-1 items-end gap-0.5">
                  {models.map(({ model, color }) => {
                    const m = cell.get(`${key}${model}`);
                    const v = cellValue(m, metric);
                    if (!v) return null;
                    return (
                      <div
                        key={model}
                        title={`${key} · ${model}: avg ${formatMs(v)} · min ${formatMs(m?.min_ms ?? null)} · max ${formatMs(m?.max_ms ?? null)}`}
                        className="min-w-0 flex-1 rounded-sm"
                        style={{
                          backgroundColor: color,
                          height: `${Math.max((v / maxTotal) * 100, 4)}%`,
                        }}
                      />
                    );
                  })}
                </div>
              );
            }
            return (
              <div
                key={key}
                title={`${key} — ${formatMetric(total, metric)} ${metric}`}
                className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-sm"
                style={{ height: `${Math.max((total / maxTotal) * 100, total ? 4 : 1)}%` }}
              >
                {models.map(({ model, color }) => {
                  const v = cellValue(cell.get(`${key}${model}`), metric);
                  if (!v) return null;
                  return (
                    <div
                      key={model}
                      title={`${model}: ${formatMetric(v, metric)}`}
                      style={{
                        backgroundColor: color,
                        height: `${(v / total) * 100}%`,
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex gap-2 text-[11px] text-[var(--color-muted)]">
          {monthKeys.map((key) => (
            <span key={key} className="min-w-0 flex-1 truncate text-center">
              {monthLabel(key)}
            </span>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-muted)]">
          {models.map(({ model, color }) => (
            <span key={model} className="flex min-w-0 items-center gap-1">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="truncate">{model}</span>
            </span>
          ))}
        </div>
        <MonthlyTable monthly={monthly} monthKeys={monthKeys} />
      </div>
    </section>
  );
}

/** Month×model rows, newest month first; "—" where no per-call data exists. */
function MonthlyTable({
  monthly,
  monthKeys,
}: {
  monthly: ModelPerfMonth[];
  monthKeys: string[];
}) {
  const shown = new Set(monthKeys);
  const rows = monthly
    .filter((m) => shown.has(m.month))
    .sort((a, b) => b.month.localeCompare(a.month) || b.calls - a.calls);
  return (
    <div className="mt-3 overflow-x-auto">
      <table data-component="ModelPerfMonthly" className="w-full text-left text-[12px]">
        <thead className="text-[11px] text-[var(--color-muted)]">
          <tr>
            <th className="py-1 pr-3 font-normal">Month</th>
            <th className="py-1 pr-3 font-normal">Model</th>
            <th className="py-1 pr-3 text-right font-normal">Calls</th>
            <th className="py-1 pr-3 text-right font-normal">Failed</th>
            <th className="py-1 pr-3 text-right font-normal">Min</th>
            <th className="py-1 pr-3 text-right font-normal">Avg</th>
            <th className="py-1 text-right font-normal">Max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={`${m.month}${m.model}`} className="border-t border-[var(--color-border)]">
              <td className="py-1 pr-3">{monthLabel(m.month)} {m.month.slice(0, 4)}</td>
              <td className="py-1 pr-3">{m.model}</td>
              <td className="py-1 pr-3 text-right">{m.calls.toLocaleString()}</td>
              <td
                className={`py-1 pr-3 text-right ${(m.failures ?? 0) > 0 ? "text-[var(--color-warn-text)]" : ""}`}
              >
                {m.failures == null ? "—" : m.failures.toLocaleString()}
              </td>
              <td className="py-1 pr-3 text-right">{formatMs(m.min_ms ?? null)}</td>
              <td className="py-1 pr-3 text-right">{formatMs(m.avg_ms)}</td>
              <td className="py-1 text-right">{formatMs(m.max_ms ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Models ▸ Performance — per-model call telemetry (calls, failures,
 * latency, tokens) for the last `period.days` days plus a monthly history
 * chart. Renders nothing until the lazy fetch resolves.
 */
export function ModelPerformance({ perf }: { perf: ModelsPerformanceResponse | null }) {
  if (!perf || !Array.isArray(perf.models)) return null;
  const monthly = Array.isArray(perf.monthly) ? perf.monthly : [];
  const days = perf.period?.days ?? 7;
  const hasHistory = monthly.length > 0;
  return (
    <>
      <section data-component="ModelPerformance">
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Performance · last {days} days
        </h2>
        {perf.collecting ? (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <p className="text-sm text-[var(--color-muted)]">
              Collecting — per-call stats appear after the first model calls
              under this build. Latency and failure history start now;
              token/call history below still reads older sessions.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {perf.models.map((m) => (
              <ModelPerfCard key={`${m.provider}:${m.model}`} entry={m} />
            ))}
          </div>
        )}
      </section>
      {hasHistory ? (
        <HistoryChart monthly={monthly} months={perf.period?.months ?? 6} />
      ) : null}
    </>
  );
}
