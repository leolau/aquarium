import type { ProjectCategory } from "@/types";

const DEFAULT_DOT = "var(--color-muted)";

/** A small round colour chip for a category (or Uncategorized). */
export function CategoryDot({ color, className = "" }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      data-component="CategoryDot"
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: color ?? DEFAULT_DOT }}
    />
  );
}

/** Where `value` lives in `categories`, or undefined for null / an unknown id. */
export function findCategory(
  categories: readonly ProjectCategory[],
  value: string | null | undefined,
): ProjectCategory | undefined {
  return value ? categories.find((c) => c.id === value) : undefined;
}

/**
 * A project's category as a coloured tag: the category's dot and name, with
 * its colour on the border and a light tint behind. Projects with no
 * category show a dashed "Uncategorized" tag. A `category_id` not (or not
 * yet) in `categories` renders nothing rather than a wrong name.
 * Server-safe (no hooks), so server pages and client views share it.
 */
export function ProjectCategoryTag({
  categories,
  categoryId,
  className = "",
}: {
  categories: readonly ProjectCategory[];
  categoryId: string | null | undefined;
  className?: string;
}) {
  const category = findCategory(categories, categoryId);
  if (categoryId && !category) return null;
  const color = category?.color ?? null;
  const name = category?.name ?? "Uncategorized";
  return (
    <span
      data-component="ProjectCategoryTag"
      data-category-id={category?.id ?? "none"}
      title={`Category: ${name}`}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        category ? "" : "border-dashed text-[var(--color-muted)]"
      } ${className}`}
      style={{
        borderColor: color ?? "var(--color-border)",
        backgroundColor: color ? `color-mix(in srgb, ${color} 14%, transparent)` : undefined,
      }}
    >
      <CategoryDot color={color} />
      <span className="sr-only">Category: </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
