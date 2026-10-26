"use client";

import type { DragEvent } from "react";

import { ActionError } from "@/components/projects/ActionError";
import { ProjectCardBody } from "@/components/projects/ProjectRow";
import type { ProjectCategory, ProjectListItem } from "@/types";

/** The drag payload type: a project slug, distinct from plain text drops. */
export const PROJECT_DRAG_TYPE = "application/x-project-slug";

/** The `<select>` value standing for "Uncategorized" (no category). */
export const UNCATEGORIZED_VALUE = "";

export interface ProjectCategoryCardProps {
  project: ProjectListItem;
  /** Every category, in column order — the "Move to…" choices. */
  categories: ProjectCategory[];
  /** The column the card sits in: a category id, or null for Uncategorized. */
  columnId: string | null;
  /** This card's move is in flight. */
  busy: boolean;
  /** Another move is in flight — moves are one at a time. */
  disabled: boolean;
  /** The failed move of this card, if any (with its same-key Retry). */
  failure: {
    error: string | null;
    busy: boolean;
    retry: () => Promise<unknown>;
  } | null;
  onMove: (categoryId: string | null) => void;
}

/**
 * One project on the category board: the shared `ProjectCardBody` (the same
 * card as the list and Home), plus the accessible "Move to…" select.
 * Desktop can also drag it to another column.
 */
export function ProjectCategoryCard({
  project,
  categories,
  columnId,
  busy,
  disabled,
  failure,
  onMove,
}: ProjectCategoryCardProps) {
  const locked = busy || disabled;
  const onDragStart = (e: DragEvent<HTMLLIElement>) => {
    e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.slug);
    e.dataTransfer.setData("text/plain", project.slug);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <li
      data-component="ProjectCategoryCard"
      data-slug={project.slug}
      draggable={!locked}
      onDragStart={locked ? undefined : onDragStart}
      aria-busy={busy || undefined}
      className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 ${
        busy ? "opacity-60" : ""
      } ${locked ? "" : "cursor-grab active:cursor-grabbing"}`}
    >
      <ProjectCardBody project={project} categories={categories} />

      <div className="mt-2 flex items-center gap-2">
        <select
          aria-label={`Move ${project.name} to…`}
          value={columnId ?? UNCATEGORIZED_VALUE}
          disabled={locked}
          onChange={(e) => {
            const next = e.target.value || null;
            if (next !== columnId) onMove(next);
          }}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-muted)] disabled:opacity-50"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
          <option value={UNCATEGORIZED_VALUE}>Uncategorized</option>
        </select>
        {busy ? (
          <span className="text-xs text-[var(--color-muted)]">Moving…</span>
        ) : null}
      </div>

      {failure ? (
        <ActionError
          action={failure}
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-400"
        />
      ) : null}
    </li>
  );
}
