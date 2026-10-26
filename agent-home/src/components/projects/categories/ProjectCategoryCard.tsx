"use client";

import type { DragEvent } from "react";

import { ActionError } from "@/components/projects/ActionError";
import { ProjectCardBody } from "@/components/projects/ProjectRow";
import type { ProjectCategory, ProjectListItem } from "@/types";

/** The drag payload type: a project slug, distinct from plain text drops. */
export const PROJECT_DRAG_TYPE = "application/x-project-slug";

export interface ProjectCategoryCardProps {
  project: ProjectListItem;
  /** Every category, for the card's category tag. */
  categories: ProjectCategory[];
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
}

/**
 * One project on the category board: the shared `ProjectCardBody` (the same
 * card as the list and Home). It moves by dragging it onto another tile; the
 * list's tick boxes + Set category move several at once.
 */
export function ProjectCategoryCard({
  project,
  categories,
  busy,
  disabled,
  failure,
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

      {busy ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">Moving…</p>
      ) : null}

      {failure ? (
        <ActionError
          action={failure}
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-400"
        />
      ) : null}
    </li>
  );
}
