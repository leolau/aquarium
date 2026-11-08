"use client";

import Link from "next/link";
import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";

import {
  durationLabel,
} from "@/components/projects/format";
import { Pill } from "@/components/ui/Pill";
import type { ProjectRunBrief, ProjectRunStatus } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useConfirm } from "@/components/ui/useConfirm";

const RUN_TONE: Record<
  ProjectRunStatus,
  "muted" | "accent" | "success" | "warning" | "danger"
> = {
  running: "accent",
  waiting: "warning",
  blocked: "danger",
  done: "success",
  failed: "danger",
  cancelled: "muted",
};

const LIVE_HINT: Partial<Record<ProjectRunStatus, string>> = {
  running: "working now",
  waiting: "waiting for you",
  blocked: "blocked — needs attention",
};

export function isLiveRun(status: ProjectRunStatus): boolean {
  return status === "running" || status === "waiting" || status === "blocked";
}

/**
 * The last runs — the record of what the project actually did. Tap a row for
 * the run page: its cards, deliveries, retro and score (§7). Live rows carry
 * Continue / Cancel / Stop inline so a run can be steered without opening
 * it; the semantics mirror the run page (Cancel lets a running card finish,
 * Stop terminates it).
 */
export function RunsPanel({
  slug,
  runs,
  archived = false,
}: {
  slug: string;
  runs: ProjectRunBrief[];
  archived?: boolean;
}) {
  const timeLabel = useTimeLabel();
  return (
    <section
      id="panel-runs"
      data-component="RunsPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Runs
      </h2>

      {runs.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No runs yet. When the readiness checklist at the top is all green,
          press <strong>Run now</strong> in the header (or set a schedule in
          Settings) — each run lands here with its outcome.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {runs.map((run) => {
            const live = isLiveRun(run.status);
            return (
              <li
                key={run.run_no}
                data-component="RunRow"
                className="rounded-lg bg-[var(--color-surface-2)]"
              >
                <Link
                  href={`/projects/${encodeURIComponent(slug)}/runs/${run.run_no}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm active:opacity-70"
                >
                  <span className="font-medium">#{run.run_no}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
                    {run.trigger} · {timeLabel(run.started_at)} ·{" "}
                    {live
                      ? `${LIVE_HINT[run.status]} · ${timeLabel(run.started_at, "ago")}`
                      : durationLabel(run.duration_seconds)}
                    {run.outcome ? ` · ${run.outcome}` : ""}
                    {run.score_user != null ? ` · ${run.score_user}/5` : ""}
                    {run.score_self != null
                      ? ` · self ${run.score_self}/5 ⚠ diverges`
                      : ""}
                  </span>
                  <Pill tone={RUN_TONE[run.status]}>{run.status}</Pill>
                </Link>
                {live && !archived ? (
                  <RunRowActions slug={slug} runNo={run.run_no} status={run.status} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {runs.length > 0 ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          newest run {timeLabel(runs[0].started_at, "ago")}
        </p>
      ) : null}
    </section>
  );
}

type RunRowAction = "continue" | "cancel" | "stop";

const ROW_PENDING: Record<RunRowAction, string> = {
  continue: "Continuing…",
  cancel: "Cancelling…",
  stop: "Stopping…",
};

/**
 * Continue / Cancel / Stop for one live run. Its own action lock, so steering
 * one run never blocks (or is mistaken for) another row's write.
 */
function RunRowActions({
  slug,
  runNo,
  status,
}: {
  slug: string;
  runNo: number;
  status: ProjectRunStatus;
}) {
  const { ask, dialog } = useConfirm();
  const action = useProjectAction();
  const [which, setWhich] = useState<RunRowAction | null>(null);
  const fire = (next: RunRowAction) => {
    if (action.busy) return;
    setWhich(next);
    void action.run(
      `/api/projects/${encodeURIComponent(slug)}/runs/${runNo}/${next}`,
    );
  };
  const actionClass =
    "rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-50";
  const pending = (name: RunRowAction) => action.busy && which === name;

  return (
    <div
      data-component="RunRowActions"
      className="flex flex-wrap items-center gap-1.5 px-3 pb-2"
    >
      {dialog}
      {status === "waiting" ? (
        <ActionButton
          busy={pending("continue")}
          pendingLabel={ROW_PENDING.continue}
          onClick={() => fire("continue")}
          disabled={action.busy}
          className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          Continue
        </ActionButton>
      ) : null}
      <ActionButton
        busy={pending("cancel")}
        pendingLabel={ROW_PENDING.cancel}
        onClick={() => fire("cancel")}
        disabled={action.busy}
        title="Stop promoting new work; a running card finishes."
        className={actionClass}
      >
        Cancel
      </ActionButton>
      <ActionButton
        busy={pending("stop")}
        pendingLabel={ROW_PENDING.stop}
        onClick={async () => {
          const ok = await ask({
            title: `Stop run ${runNo} now?`,
            body: "Work in progress is terminated where it stands — Cancel instead lets a running card finish.",
            confirmLabel: "Stop now",
          });
          if (ok) fire("stop");
        }}
        disabled={action.busy}
        className={`${actionClass} text-[var(--color-danger)]`}
      >
        Stop now
      </ActionButton>
      <ActionError
        action={action}
        className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]"
      />
    </div>
  );
}
