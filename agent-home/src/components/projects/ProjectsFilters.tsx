"use client";

import {
  FILTER_CHIPS,
  SORT_OPTIONS,
  defaultSortOrder,
  type ProjectsFilterState,
  type ProjectsSort,
} from "@/components/projects/filters";

/**
 * Search and the seven view chips (§13). The chips are single-select on
 * purpose — each names one slice of the list, and slicing by status *and*
 * cadence at once is a query nobody types; the URL still carries the exact
 * parameters for anyone who wants one.
 */
export function ProjectsFilters({
  value,
  onChange,
}: {
  value: ProjectsFilterState;
  onChange: (next: ProjectsFilterState) => void;
}) {
  return (
    <div data-component="ProjectsFilters" className="flex flex-col gap-2">
      <input
        type="search"
        value={value.q}
        onChange={(e) => onChange({ ...value, q: e.target.value })}
        placeholder="Search projects"
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip.view}
            type="button"
            onClick={() => onChange({ ...value, view: chip.view })}
            aria-pressed={value.view === chip.view}
            className={`rounded-full border px-2 py-1 transition ${
              value.view === chip.view
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div
        data-component="ProjectsSort"
        className="flex items-center gap-2 text-xs text-[var(--color-muted)]"
      >
        <label htmlFor="projects-sort">Sort by</label>
        <select
          id="projects-sort"
          value={value.sort}
          onChange={(e) => {
            const sort = e.target.value as ProjectsSort;
            onChange({ ...value, sort, order: defaultSortOrder(sort) });
          }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-fg)]"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.sort} value={option.sort}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-component="ProjectsSortOrder"
          onClick={() =>
            onChange({
              ...value,
              order: value.order === "asc" ? "desc" : "asc",
            })
          }
          aria-label={
            value.order === "asc"
              ? "Ascending — switch to descending"
              : "Descending — switch to ascending"
          }
          title={value.order === "asc" ? "Ascending" : "Descending"}
          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-fg)]"
        >
          {value.order === "asc" ? "↑ Ascending" : "↓ Descending"}
        </button>
      </div>
    </div>
  );
}
