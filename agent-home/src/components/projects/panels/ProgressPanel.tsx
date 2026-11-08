import Link from "next/link";

import { outputsLabel } from "@/components/projects/outputsLabel";
import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectBoardTask, ProjectDetail } from "@/types";

/**
 * The ladder's headline WITH its label (§9.1) and the card rollup beside it;
 * then blocked cards. What a person should do next lives in the Dashboard's
 * hero (`dashboard/nextAction.ts`), not here.
 */
export function ProgressPanel({
  slug,
  project,
  blockedCards,
}: {
  slug: string;
  project: ProjectDetail;
  blockedCards: ProjectBoardTask[];
  /** Unused since the Dashboard hero took over "what next"; kept for callers. */
  readiness?: ReadinessItem[];
}) {
  const { progress, card_rollup: rollup } = project;
  const outputs = outputsLabel(project.output_rollup);
  return (
    <section
      id="panel-progress"
      data-component="ProgressPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Progress
      </h2>

      <p className="mt-2 text-sm">
        <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
          {progress.label}
        </span>{" "}
        <span className="font-medium">{progress.headline}</span>
      </p>

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        {rollup.done} of {rollup.total} cards done
        {rollup.running > 0 ? ` · ${rollup.running} running` : ""}
        {rollup.blocked > 0 ? ` · ${rollup.blocked} blocked` : ""}
      </p>
      {outputs ? (
        <p data-component="OutputsRollup" className="mt-1 text-xs text-[var(--color-muted)]">
          {outputs}
        </p>
      ) : null}

      {blockedCards.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2" data-component="BlockedCards">
          {blockedCards.map((card) => (
            <li key={card.id}>
              <Link
                href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(card.id)}`}
                className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{card.title}</span>
                <span className="text-xs text-[var(--color-danger)]">blocked</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
