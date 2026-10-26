"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  CategoryDot,
  findCategory,
} from "@/components/projects/categories/ProjectCategoryTag";
import { sortCategories } from "@/components/projects/categories/useProjectCategories";
import { UNCATEGORIZED_FILTER } from "@/components/projects/filters";
import type { ProjectCategory } from "@/types";

type Option = { id: string; name: string; color: string | null };

/**
 * The list view's category filter: a multi-select of Uncategorized plus every
 * category in column order. Nothing ticked = every category. An id in the URL
 * that is not (or not yet) a category stays ticked as "Unknown category" so it
 * can be unticked rather than narrowing the list invisibly.
 */
export function ProjectsCategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: readonly ProjectCategory[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ordered = sortCategories([...categories]);
  const options: Option[] = [
    ...ordered.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    { id: UNCATEGORIZED_FILTER, name: "Uncategorized", color: null },
    ...value
      .filter((id) => id !== UNCATEGORIZED_FILTER && !findCategory(ordered, id))
      .map((id) => ({ id, name: "Unknown category", color: null })),
  ];
  const selected = options.filter((o) => value.includes(o.id));

  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );

  return (
    <div
      ref={root}
      data-component="ProjectsCategoryFilter"
      className="relative flex items-center gap-2 text-xs"
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-1 ${
          selected.length > 0
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-border)] text-[var(--color-muted)]"
        }`}
      >
        {selected.length > 0 ? (
          selected.map((o) => <CategoryDot key={o.id} color={o.color} className="h-2 w-2" />)
        ) : null}
        <span className="truncate">
          Category:{" "}
          {selected.length > 0
            ? selected.map((o) => o.name).join(", ")
            : "All categories"}
        </span>
        <span aria-hidden>▾</span>
      </button>
      {selected.length > 0 ? (
        <button
          type="button"
          aria-label="Show every category"
          onClick={() => onChange([])}
          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)]"
        >
          Clear
        </button>
      ) : null}
      {open ? (
        <div
          id={menuId}
          role="group"
          aria-label="Categories"
          className="absolute left-0 top-full z-20 mt-1 flex max-h-72 w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
        >
          {options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]"
            >
              <input
                type="checkbox"
                checked={value.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <CategoryDot color={o.color} />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
