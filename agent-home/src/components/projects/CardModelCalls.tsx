"use client";

import { callDurationLabel } from "@/components/projects/format";
import type { CardCallStats, CardModelCalls as CardModelCallsData } from "@/types";

function callerLabel(caller: string): string {
  if (caller === "main") return "main model";
  const task = caller.startsWith("aux:") ? caller.slice(4) : caller;
  return task === "vision" ? "image checks" : task.replace(/_/g, " ");
}

function attemptLabel(attempt: number | null, outcome: string | null): string {
  if (attempt == null) return "Unmatched run";
  return outcome ? `Attempt ${attempt} · ${outcome}` : `Attempt ${attempt}`;
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--color-muted)]">{label}</dt>
      <dd className={warn ? "text-[var(--color-warn-text)]" : undefined}>{value}</dd>
    </div>
  );
}

function Totals({ stats }: { stats: CardCallStats }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-5">
      <Stat label="Calls" value={stats.calls.toLocaleString()} />
      <Stat
        label="Failed"
        value={stats.failures.toLocaleString()}
        warn={stats.failures > 0}
      />
      <Stat label="Avg per call" value={callDurationLabel(stats.avg_ms)} />
      <Stat label="Min" value={callDurationLabel(stats.min_ms)} />
      <Stat label="Max" value={callDurationLabel(stats.max_ms)} />
    </dl>
  );
}

/**
 * A card's provider calls across every worker attempt: main-model totals,
 * then one row per attempt, caller (main / image checks / …) and model.
 * Re-renders with the card, so a running card's numbers move live.
 */
export function CardModelCalls({ data }: { data: CardModelCallsData | null | undefined }) {
  const rows = data?.rows ?? [];
  return (
    <section
      data-component="CardModelCalls"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Model calls · all attempts
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No model calls recorded for this card yet.
        </p>
      ) : (
        <>
          {data?.main ? (
            <>
              <p className="mt-2 text-[11px] text-[var(--color-muted)]">Main model</p>
              <Totals stats={data.main} />
            </>
          ) : null}
          <div className="mt-3 sm:overflow-x-auto">
            {/* Phone: each row becomes a stacked card, each cell labelled. */}
            <table className="w-full text-left text-[12px] max-sm:block">
              <thead className="text-[11px] text-[var(--color-muted)] max-sm:hidden">
                <tr>
                  <th className="py-1 pr-3 font-normal">Attempt</th>
                  <th className="py-1 pr-3 font-normal">Model</th>
                  <th className="py-1 pr-3 text-right font-normal">Calls</th>
                  <th className="py-1 pr-3 text-right font-normal">Failed</th>
                  <th className="py-1 pr-3 text-right font-normal">Min</th>
                  <th className="py-1 pr-3 text-right font-normal">Avg</th>
                  <th className="py-1 text-right font-normal">Max</th>
                </tr>
              </thead>
              <tbody className="max-sm:flex max-sm:flex-col max-sm:gap-2">
                {rows.map((r) => (
                  <tr
                    key={`${r.run_id ?? "none"}:${r.caller}:${r.provider}:${r.model}`}
                    className="border-t border-[var(--color-border)] max-sm:block max-sm:rounded-[var(--radius-md)] max-sm:border max-sm:p-2"
                  >
                    <td data-label="Attempt" className="py-1 pr-3 max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">{attemptLabel(r.attempt, r.run_outcome)}</td>
                    <td data-label="Model" className="py-1 pr-3 max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">
                      {r.model}
                      <span className="block text-[11px] text-[var(--color-muted)]">
                        {callerLabel(r.caller)}
                        {r.provider ? ` · ${r.provider}` : ""}
                      </span>
                    </td>
                    <td data-label="Calls" className="py-1 pr-3 text-right max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">{r.calls.toLocaleString()}</td>
                    <td
                      data-label="Failed"
                      className={`py-1 pr-3 text-right max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)] ${r.failures > 0 ? "text-[var(--color-warn-text)]" : ""}`}
                    >
                      {r.failures}
                    </td>
                    <td data-label="Min" className="py-1 pr-3 text-right max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">{callDurationLabel(r.min_ms)}</td>
                    <td data-label="Avg" className="py-1 pr-3 text-right max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">{callDurationLabel(r.avg_ms)}</td>
                    <td data-label="Max" className="py-1 text-right max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:text-right max-sm:before:text-[var(--color-muted)] max-sm:before:content-[attr(data-label)]">{callDurationLabel(r.max_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
