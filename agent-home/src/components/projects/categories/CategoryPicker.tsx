"use client";

import { useId } from "react";

import {
  CategoryDot,
  findCategory,
} from "@/components/projects/categories/ProjectCategoryTag";
import { sortCategories } from "@/components/projects/categories/useProjectCategories";
import type { ProjectCategory } from "@/types";

export { CategoryDot, findCategory };

/** The swatches a category can be painted with (null = the default tone). */
export const CATEGORY_COLORS: { value: string; label: string }[] = [
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#10b981", label: "Green" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
  { value: "#64748b", label: "Slate" },
];

/**
 * A labelled `<select>` of "Uncategorized" (null) plus the categories in
 * column order, each tinted with its colour. An id that is not (or not yet)
 * in the list stays selected as "Unknown category" rather than silently
 * reading as another choice.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  disabled,
  id,
  label = "Category",
}: {
  categories: ProjectCategory[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  const generated = useId();
  const selectId = id ?? `category-picker-${generated}`;
  const ordered = sortCategories(categories);
  const selected = findCategory(ordered, value);
  const unknown = Boolean(value) && !selected;

  return (
    <div data-component="CategoryPicker" className="flex flex-col gap-1 text-sm">
      <label htmlFor={selectId}>{label}</label>
      <div className="flex items-center gap-2">
        <CategoryDot color={selected?.color ?? null} />
        <select
          id={selectId}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        >
          <option value="">Uncategorized</option>
          {ordered.map((category) => (
            <option
              key={category.id}
              value={category.id}
              style={category.color ? { color: category.color } : undefined}
            >
              {category.name}
            </option>
          ))}
          {unknown ? <option value={value ?? ""}>Unknown category</option> : null}
        </select>
      </div>
    </div>
  );
}
