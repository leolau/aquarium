"use client";

import { useState, type DragEvent } from "react";

import {
  PROJECT_DRAG_TYPE,
  ProjectCategoryCard,
} from "@/components/projects/categories/ProjectCategoryCard";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { Project, ProjectCategory, ProjectListItem } from "@/types";

export interface CategoryColumn {
  /** The category, or null for the trailing "Uncategorized" column. */
  category: ProjectCategory | null;
  items: ProjectListItem[];
}

/** Column order: `position`, then `created_at` — the API's own order. */
export function orderCategories(categories: ProjectCategory[]): ProjectCategory[] {
  return [...categories].sort(
    (a, b) => a.position - b.position || a.created_at - b.created_at,
  );
}

/**
 * One column per category in column order, then "Uncategorized" — which also
 * catches a `category_id` the board doesn't know (deleted meanwhile, or a
 * stale categories read), so no project ever falls off the board.
 */
export function groupProjectsByCategory(
  items: ProjectListItem[],
  categories: ProjectCategory[],
): CategoryColumn[] {
  const columns: CategoryColumn[] = orderCategories(categories).map(
    (category) => ({ category, items: [] }),
  );
  const byId = new Map(columns.map((c) => [c.category!.id, c]));
  const uncategorized: CategoryColumn = { category: null, items: [] };
  for (const project of items) {
    const column =
      (project.category_id ? byId.get(project.category_id) : undefined) ??
      uncategorized;
    column.items.push(project);
  }
  return [...columns, uncategorized];
}

/**
 * The `/projects` category board: a responsive grid of tiles (one per
 * category, then Uncategorized). Each tile shows its project count and a
 * List button that opens the list view narrowed to that category. A card
 * moves through its "Move to…" select or, on desktop, by dragging it onto
 * another tile; both send the same `PATCH /api/projects/{slug}`
 * `{category_id}` through `useProjectAction`, one move at a time, and patch
 * the item locally.
 */
export function ProjectsCategoryBoard({
  items,
  categories,
  onMoved,
  onOpenList,
}: {
  items: ProjectListItem[];
  categories: ProjectCategory[];
  onMoved: (slug: string, categoryId: string | null) => void;
  /** Open the list view narrowed to one category (null = Uncategorized). */
  onOpenList?: (categoryId: string | null) => void;
}) {
  const action = useProjectAction<Project>();
  // The card the last move was for: busy while in flight, owns the error.
  const [target, setTarget] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState<string | null | undefined>(
    undefined,
  );
  const columns = groupProjectsByCategory(items, categories);
  const ordered = columns.flatMap((c) => (c.category ? [c.category] : []));
  const columnOf = new Map<string, string | null>();
  for (const column of columns) {
    for (const project of column.items) {
      columnOf.set(project.slug, column.category?.id ?? null);
    }
  }

  const move = (slug: string, categoryId: string | null) => {
    if (action.busy) return;
    setTarget(slug);
    void action.run(`/api/projects/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: { category_id: categoryId },
      skipRefresh: true,
      onSuccess: (project) =>
        onMoved(slug, project.category_id ?? categoryId ?? null),
    });
  };

  const dragOver = (e: DragEvent<HTMLElement>, columnId: string | null) => {
    if (action.busy || !e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropOver !== columnId) setDropOver(columnId);
  };

  const drop = (e: DragEvent<HTMLElement>, columnId: string | null) => {
    setDropOver(undefined);
    const slug = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
    if (!slug || !columnOf.has(slug)) return;
    e.preventDefault();
    if (columnOf.get(slug) !== columnId) move(slug, columnId);
  };

  return (
    <div data-component="ProjectsCategoryBoard" className="flex flex-col gap-2">
      {categories.length === 0 ? (
        <p
          data-component="ProjectsCategoryHint"
          className="text-xs text-[var(--color-muted)]"
        >
          No categories yet — use Manage categories to add groups like Sales
          or Research.
        </p>
      ) : null}
      <div
        data-component="ProjectsCategoryGrid"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {columns.map((column) => {
          const columnId = column.category?.id ?? null;
          const name = column.category?.name ?? "Uncategorized";
          return (
            <section
              key={columnId ?? "__uncategorized"}
              data-component="ProjectsCategoryColumn"
              data-category={columnId ?? "none"}
              aria-label={name}
              onDragOver={(e) => dragOver(e, columnId)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDropOver(undefined);
                }
              }}
              onDrop={(e) => drop(e, columnId)}
              className={`flex min-w-0 flex-col gap-2 rounded-2xl border bg-[var(--color-surface-2)] p-2 ${
                dropOver === columnId
                  ? "border-[var(--color-accent)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              <header className="flex items-center gap-2 px-1">
                <span
                  aria-hidden
                  data-component="ProjectsCategoryDot"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      column.category?.color ?? "var(--color-muted)",
                  }}
                />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {name}
                </h2>
                <span
                  data-component="ProjectsCategoryCount"
                  className="shrink-0 text-xs text-[var(--color-muted)]"
                >
                  {column.items.length}{" "}
                  {column.items.length === 1 ? "project" : "projects"}
                </span>
                {onOpenList ? (
                  <button
                    type="button"
                    data-component="ProjectsCategoryListAction"
                    aria-label={`List ${name} projects`}
                    title={`List ${name} projects`}
                    onClick={() => onOpenList(columnId)}
                    className="shrink-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
                  >
                    List
                  </button>
                ) : null}
              </header>
              {column.items.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-[var(--color-muted)]">
                  No projects
                </p>
              ) : (
                <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
                  {column.items.map((project) => {
                    const mine = target === project.slug;
                    return (
                      <ProjectCategoryCard
                        key={project.id}
                        project={project}
                        categories={ordered}
                        columnId={columnId}
                        busy={mine && action.busy}
                        disabled={action.busy && !mine}
                        failure={mine && action.error ? action : null}
                        onMove={(next) => move(project.slug, next)}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
