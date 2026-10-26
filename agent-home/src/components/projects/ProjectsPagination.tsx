"use client";

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

/** Page numbers to show: all of them up to 7, else first, last and the
 * current page's neighbours with gaps (`null`) between. */
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const keep = new Set([1, pageCount, page - 1, page, page + 1]);
  const out: (number | null)[] = [];
  for (let n = 1; n <= pageCount; n++) {
    if (keep.has(n)) out.push(n);
    else if (out.at(-1) !== null) out.push(null);
  }
  return out;
}

/**
 * The project list's pager: "21–40 of 57", Previous / page numbers / Next and
 * a per-page choice. Pure view: the list owns the page and the page size.
 */
export function ProjectsPagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  if (total === 0) return null;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const step =
    "rounded-lg border border-[var(--color-border)] px-2.5 py-1 disabled:opacity-40";
  return (
    <nav
      aria-label="Pages"
      data-component="ProjectsPagination"
      className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-[var(--color-muted)]"
    >
      <span data-component="ProjectsPageRange">
        {first}–{last} of {total}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className={step}
        >
          Previous
        </button>
        {pageWindow(page, pageCount).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} aria-hidden className="px-1">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              aria-label={`Page ${n}`}
              aria-current={n === page ? "page" : undefined}
              onClick={() => onPage(n)}
              className={`rounded-lg border px-2.5 py-1 ${
                n === page
                  ? "border-[var(--color-accent)] font-medium text-[var(--color-accent)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              {n}
            </button>
          ),
        )}
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          className={step}
        >
          Next
        </button>
      </div>
      <label className="flex items-center gap-1.5">
        Per page
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}
