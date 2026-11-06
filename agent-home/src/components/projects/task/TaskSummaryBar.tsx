"use client";

import { useNow } from "@/components/projects/live/LiveStatusBar";
import { elapsedLabel } from "@/components/projects/live/liveState";
import type { ProjectDetail, ProjectRun } from "@/types";

import { taskSummary } from "./taskState";

/**
 * Total time and spend for the task, kept current without a poll of its
 * own: the clock ticks client-side (after hydration), tokens arrive with the
 * page's event-driven refresh, and run cost with the run stream the page
 * already holds open.
 */
export function TaskSummaryBar({ project, run }: { project: ProjectDetail; run: ProjectRun | null }) {
  const now = useNow();
  const s = taskSummary(project, run, now);
  const items: { label: string; value: string; key: string }[] = [
    { key: "total", label: "Total time", value: elapsedLabel(s.totalSeconds) },
  ];
  if (s.runNo != null) {
    items.push({ key: "run", label: s.runs > 1 ? `Run ${s.runNo}` : "This run", value: elapsedLabel(s.runSeconds) });
  }
  items.push({
    key: "tokens",
    label: "Tokens",
    value: s.tokens != null ? s.tokens.toLocaleString("en") : "not recorded",
  });
  if (s.costUsd != null) items.push({ key: "cost", label: "Cost", value: `$${s.costUsd.toFixed(2)}` });
  return (
    <dl
      data-component="TaskSummaryBar"
      aria-label="Time and spend"
      className="grid grid-cols-2 gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs sm:flex sm:flex-wrap sm:gap-x-6"
    >
      {items.map((item) => (
        <div key={item.key} data-summary={item.key} className="min-w-0">
          <dt className="text-[var(--color-muted)]">{item.label}</dt>
          <dd className="text-sm font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
