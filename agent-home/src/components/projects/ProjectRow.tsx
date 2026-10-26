import Link from "next/link";

import {
  dayDistance,
  durationLabel,
  tokenCountLabel,
} from "@/components/projects/format";
import { outputsLabel } from "@/components/projects/outputsLabel";
import { ProjectCategoryTag } from "@/components/projects/categories/ProjectCategoryTag";
import { Pill, type Tone } from "@/components/ui/Pill";
import type {
  ProjectCadence,
  ProjectCategory,
  ProjectHealth,
  ProjectListItem,
} from "@/types";

/** §13: the cadence glyph leads the row because it sets what a row promises. */
export const CADENCE_GLYPH: Record<ProjectCadence, string> = {
  one_off: "▣",
  repeatable: "↻",
  standing: "∞",
};

export const CADENCE_LABEL: Record<ProjectCadence, string> = {
  one_off: "one-off",
  repeatable: "repeatable",
  standing: "standing",
};

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  ok: "ok",
  attention: "attention",
  stalled: "stalled",
};

export const HEALTH_TONE: Record<ProjectHealth, Tone> = {
  ok: "success",
  attention: "warning",
  stalled: "danger",
};

/**
 * Epoch seconds → a distance the row can show: "today", "in 3d", "5d ago".
 * The list only ever needs the day grain — a run scheduled for 14:00 is
 * still "today" at 09:00. Lives in `format.ts`; re-exported here so the
 * list-era imports keep working.
 */
export { dayDistance } from "@/components/projects/format";

/**
 * The shared body of every project card — the `/projects` list row, the
 * category board card and the Home card: the cadence glyph, the bold `name`,
 * the coloured category tag, the "to accept" and health pills, the dimmed
 * `goal` truncated to one line, then cadence · when · progress headline ·
 * members — everything the backend computes, so the card never re-derives
 * what `progress.headline` already says. Pure and server-safe.
 */
export function ProjectCardBody({
  project,
  categories,
}: {
  project: ProjectListItem;
  /** Every category, to name and colour the project's tag. */
  categories: readonly ProjectCategory[];
}) {
  const when =
    project.cadence === "one_off" && project.due_at != null
      ? `due ${dayDistance(project.due_at)}`
      : project.next_run_at != null
        ? `next ${dayDistance(project.next_run_at)}`
        : project.schedule || null;
  // The outputs line repeats the headline when the outputs rung won.
  const outputs =
    project.progress.rung === "outputs" ? null : outputsLabel(project.output_rollup);
  const awaiting = project.output_rollup?.awaiting_acceptance ?? 0;
  // The value a duration/tokens sort orders on, so the order is legible.
  const runSeconds = project.usage?.run_seconds;
  const tokens = project.usage?.tokens_total;
  const meta = [
    CADENCE_LABEL[project.cadence],
    when,
    project.completed_at != null
      ? `completed ${dayDistance(project.completed_at)}`
      : null,
    runSeconds != null ? `ran ${durationLabel(runSeconds)}` : null,
    tokens != null ? `${tokenCountLabel(tokens)} tokens` : null,
    project.progress.headline,
    outputs,
    project.member_count > 0
      ? `${project.member_count} ${project.member_count === 1 ? "member" : "members"}`
      : null,
  ].filter(Boolean);

  return (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[var(--color-muted)]">
          {CADENCE_GLYPH[project.cadence]}
        </span>
        <Link
          href={`/projects/${encodeURIComponent(project.slug)}`}
          draggable={false}
          className="min-w-0 flex-1 truncate text-sm font-semibold"
        >
          {project.name}
        </Link>
        {awaiting > 0 ? (
          <Pill tone="warning">{awaiting} to accept</Pill>
        ) : null}
        <Pill tone={HEALTH_TONE[project.health]}>
          {HEALTH_LABEL[project.health]}
        </Pill>
      </div>

      <div className="mt-1 flex">
        <ProjectCategoryTag categories={categories} categoryId={project.category_id} />
      </div>

      {project.status === "needs_completion" ? (
        <p className="mt-1 truncate text-sm italic text-[var(--color-muted)]">
          Imported from a legacy store — needs completion (goal, outputs,
          host profile)
        </p>
      ) : project.goal ? (
        <p className="mt-1 truncate text-sm text-[var(--color-muted)]">
          {project.goal}
        </p>
      ) : null}

      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {meta.join(" · ")}
      </p>
    </>
  );
}

/** One project card in a list: the shared `ProjectCardBody` in its frame. */
export function ProjectRow({
  project,
  categories = [],
}: {
  project: ProjectListItem;
  categories?: readonly ProjectCategory[];
}) {
  return (
    <li
      data-component="ProjectRow"
      data-slug={project.slug}
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <ProjectCardBody project={project} categories={categories} />
    </li>
  );
}
