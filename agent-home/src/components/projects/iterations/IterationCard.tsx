import Link from "next/link";

import { durationLabel } from "@/components/projects/format";
import type { Iteration, IterationStatus } from "@/components/projects/iterations/groupIterations";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

const STATUS: Record<IterationStatus, { label: string; tone: Tone }> = {
  upcoming: { label: "ready to start", tone: "muted" },
  running: { label: "running", tone: "accent" },
  waiting: { label: "waiting for you", tone: "warning" },
  blocked: { label: "blocked", tone: "danger" },
  done: { label: "done", tone: "success" },
  failed: { label: "failed", tone: "danger" },
  cancelled: { label: "stopped", tone: "muted" },
};

/** One iteration: requirement version + plan revision + its runs and deliveries. */
export function IterationCard({ iteration, slug }: { iteration: Iteration; slug: string }) {
  const timeLabel = useTimeLabel();
  const status = STATUS[iteration.status];
  const runs = iteration.runs.length;
  return (
    <details
      data-component="IterationCard"
      data-iteration={iteration.no}
      open={iteration.current || iteration.status === "upcoming"}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Iteration {iteration.no}</span>
        <Pill tone={status.tone}>{status.label}</Pill>
        <span className="text-xs text-[var(--color-muted)]">
          {iteration.planRev != null ? `plan rev ${iteration.planRev}` : "no plan yet"}
          {runs ? ` · ${runs} ${runs === 1 ? "run" : "runs"}` : ""}
          {iteration.startedAt ? ` · ${timeLabel(iteration.startedAt)}` : ""}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-sm">
        <p className="text-xs text-[var(--color-muted)]">
          {iteration.requirementIds.length
            ? `${iteration.requirementIds.length} standing ${
                iteration.requirementIds.length === 1 ? "requirement" : "requirements"
              }`
            : "No standing requirements beyond the brief"}
        </p>
        {iteration.added.length || iteration.retired.length ? (
          <ul className="flex flex-col gap-1">
            {iteration.added.map((r) => (
              <li key={`a-${r.id}`} className="text-emerald-300">
                + {r.body}
              </li>
            ))}
            {iteration.retired.map((r) => (
              <li key={`r-${r.id}`} className="text-[var(--color-danger)] line-through">
                − {r.body}
              </li>
            ))}
          </ul>
        ) : null}
        {iteration.status === "upcoming" ? (
          <p className="text-xs text-[var(--color-muted)]">
            Not started yet. These changes apply from the next run.
          </p>
        ) : null}
        {runs ? (
          <ul className="flex flex-col gap-1">
            {iteration.runs
              .slice()
              .reverse()
              .map((run) => (
                <li key={run.run_no}>
                  <Link
                    href={`/projects/${encodeURIComponent(slug)}/runs/${run.run_no}`}
                    className="flex flex-wrap items-center gap-x-2 rounded-lg px-1 py-0.5 hover:bg-[var(--color-surface-2)]"
                  >
                    <span className="font-medium">Run {run.run_no}</span>
                    <span className="text-xs">{STATUS[run.status].label}</span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {durationLabel(run.duration_seconds)}
                      {run.cardsTotal ? ` · ${run.cardsDone ?? 0}/${run.cardsTotal} steps` : ""}
                      {run.outcome ? ` · ${run.outcome}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        ) : null}
        {iteration.deliveries.length ? (
          <div>
            <p className="text-xs text-[var(--color-muted)]">Delivered</p>
            <ul className="flex flex-col gap-0.5">
              {iteration.deliveries.map(({ outputTitle, delivery }) => (
                <li key={delivery.id} className="break-words">
                  ✓ {outputTitle}
                  {delivery.label ? ` — ${delivery.label}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
