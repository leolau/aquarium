"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the visible list re-reads its first page — project statuses,
 * health and next-run move without anyone touching this page. */
const AUTO_REFRESH_MS = 30_000;

import { ProjectRow } from "@/components/projects/ProjectRow";
import { ProjectsBulkBar } from "@/components/projects/ProjectsBulkBar";
import { ProjectsFilters } from "@/components/projects/ProjectsFilters";
import {
  DEFAULT_PAGE_SIZE,
  ProjectsPagination,
} from "@/components/projects/ProjectsPagination";
import { ProjectCategoriesSheet } from "@/components/projects/categories/ProjectCategoriesSheet";
import { ProjectsCategoryBoard } from "@/components/projects/categories/ProjectsCategoryBoard";
import { ProjectsCategoryFilter } from "@/components/projects/categories/ProjectsCategoryFilter";
import { fetchProjectCategories } from "@/components/projects/categories/useProjectCategories";
import {
  EMPTY_FILTERS,
  UNCATEGORIZED_FILTER,
  filtersFromParams,
  filtersToParams,
  type ProjectsFilterState,
  type ProjectsLayout,
} from "@/components/projects/filters";
import type {
  ProjectCategory,
  ProjectListItem,
  ProjectsResponse,
} from "@/types";

/** Both layouts read every matching project, in the API's largest page size
 * and capped so a huge instance can't fetch forever. */
export const BOARD_PAGE_SIZE = 200;
export const BOARD_CAP = 500;

const LAYOUTS: { layout: ProjectsLayout; label: string }[] = [
  { layout: "board", label: "Board" },
  { layout: "list", label: "List" },
];

/**
 * The project list: everything the agent is working on, running on a
 * schedule, or standing watch over.
 *
 * Filters round-trip through the URL (the cursor never does), and the first
 * page is the server's — so the debounce arms on the first interaction
 * instead of refetching the page that just rendered.
 *
 * Both layouts read every matching project (all API pages, up to
 * `BOARD_CAP`), and the auto-refresh re-reads all of them. The category
 * board is the default layout; `layout=list` swaps it for the list, which
 * pages through them on the client (page numbers, per-page choice) and lets
 * the person tick projects to re-categorise, archive or restore in bulk.
 * A board tile's List button opens the list
 * narrowed to that category (`layout=list&category=<id|none>`); the list
 * can then tick any set of categories (`category=<id>,<id>,none`).
 */
export function ProjectsList({
  initial,
  categories: initialCategories = [],
  initialFilters,
}: {
  initial: ProjectsResponse;
  /** The board's columns, in any order (the board sorts by `position`). */
  categories?: ProjectCategory[];
  /** The server's parse of the same URL, so SSR renders the same layout. */
  initialFilters?: ProjectsFilterState;
}) {
  const [items, setItems] = useState<ProjectListItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [categories, setCategories] =
    useState<ProjectCategory[]>(initialCategories);
  const [managing, setManaging] = useState(false);
  // The server rendered from the same URL, so the state starts from the
  // address bar rather than from an effect that would flash the default view.
  const [filters, setFilters] = useState<ProjectsFilterState>(() =>
    typeof window === "undefined"
      ? (initialFilters ?? EMPTY_FILTERS)
      : filtersFromParams(new URLSearchParams(window.location.search)),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // Ticked project slugs; kept across pages, dropped when the view changes.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Mirrors `loading` for the interval callback (which must not re-arm on
  // every fetch or the cadence would never settle). Written only inside
  // `fetchPage` — assigning a ref during render is off-limits.
  const loadingRef = useRef(false);

  const fetchPage = useCallback(
    async (value: ProjectsFilterState) => {
      setLoading(true);
      loadingRef.current = true;
      setError(null);
      try {
        // Walk every page from the top.
        let next: string | null = null;
        let collected: ProjectListItem[] = [];
        do {
          const params = filtersToParams(value, next);
          // A view preference, not a filter: never sent upstream.
          params.delete("layout");
          params.set("limit", String(BOARD_PAGE_SIZE));
          const res = await fetch(`/api/projects?${params.toString()}`, {
            cache: "no-store",
          });
          if (!res.ok) {
            setError(
              res.status === 401
                ? "Your session expired — sign in again."
                : "Couldn't load your projects.",
            );
            return;
          }
          const body = (await res.json()) as ProjectsResponse;
          collected = [...collected, ...body.items];
          next = body.next_cursor;
        } while (next && collected.length < BOARD_CAP);
        setItems(collected.slice(0, BOARD_CAP));
        // A cursor left over means the cap cut the read short.
        setCursor(next);
      } catch {
        setError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [],
  );

  // A stale categories answer never overwrites a newer one.
  const categoriesSeq = useRef(0);
  const reloadCategories = useCallback(async () => {
    const mine = ++categoriesSeq.current;
    try {
      const fresh = await fetchProjectCategories();
      if (mine === categoriesSeq.current) setCategories(fresh);
    } catch {
      // Keep the last good list; the next refresh tries again.
    }
  }, []);

  const armed = useRef(false);
  // The server sent its first page only: when more remain, the first pass
  // reads the rest instead of skipping.
  const needsRest = useRef(initial.next_cursor !== null);
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      if (!needsRest.current) return;
    }
    const timer = setTimeout(() => {
      const params = filtersToParams(filters);
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        query ? `/projects?${query}` : "/projects",
      );
      void fetchPage(filters);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, fetchPage]);

  // Live list: health, status and next-run move without a reload. Re-read
  // every page on a cadence while the tab is visible and the moment focus
  // returns — the same pattern the chat unread badge uses — skipped while a
  // fetch is already in flight.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible" || loadingRef.current) {
        return;
      }
      void fetchPage(filters);
      if (filters.layout === "board") void reloadCategories();
    };
    const interval = window.setInterval(tick, AUTO_REFRESH_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [filters, fetchPage, reloadCategories]);

  const narrowed =
    filters !== EMPTY_FILTERS &&
    (filters.view !== "active" || filters.categoryIds.length > 0);
  const board = filters.layout === "board";

  const onMoved = useCallback((slug: string, categoryId: string | null) => {
    setItems((prev) =>
      prev.map((p) => (p.slug === slug ? { ...p, category_id: categoryId } : p)),
    );
  }, []);

  // A rename/recolour changes the tiles; a delete also moves that
  // category's projects to Uncategorized server-side, so re-read them.
  const onCategoriesChanged = useCallback(
    (next: ProjectCategory[]) => {
      categoriesSeq.current++;
      setCategories(next);
      void fetchPage(filters);
    },
    [filters, fetchPage],
  );

  // Closing the sheet re-reads both, so the board can never keep showing a
  // list from before the edits (e.g. a re-read inside the sheet failed).
  const closeManaging = useCallback(() => {
    setManaging(false);
    void reloadCategories();
    void fetchPage(filters);
  }, [filters, fetchPage, reloadCategories]);

  // A new view starts on page 1 with nothing ticked: a tick the person can
  // no longer see must never be archived by accident.
  const changeFilters = useCallback((next: ProjectsFilterState) => {
    setFilters(next);
    setPage(1);
    setSelected(new Set());
  }, []);

  const openCategoryList = useCallback(
    (categoryId: string | null) => {
      changeFilters({
        ...filters,
        layout: "list",
        categoryIds: [categoryId ?? UNCATEGORIZED_FILTER],
      });
    },
    [filters, changeFilters],
  );

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = board
    ? items
    : items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedItems = items.filter((p) => selected.has(p.slug));

  const toggleSelected = (slug: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const selectPage = (select: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of pageItems) {
        if (select) next.add(p.slug);
        else next.delete(p.slug);
      }
      return next;
    });

  // What went through is unticked; what was refused stays ticked to retry.
  const onBulkDone = useCallback(
    (succeeded: string[]) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const slug of succeeded) next.delete(slug);
        return next;
      });
      void fetchPage(filters);
    },
    [filters, fetchPage],
  );

  return (
    <div data-component="ProjectsList" className="flex flex-col gap-3">
      {/* The create door (§13): the feature is unreachable if its only
          entrance is a CLI verb. */}
      <div className="flex items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Layout"
          data-component="ProjectsLayoutToggle"
          className="flex rounded-xl border border-[var(--color-border)] p-0.5 text-xs"
        >
          {LAYOUTS.map((option) => (
            <button
              key={option.layout}
              type="button"
              aria-pressed={filters.layout === option.layout}
              onClick={() =>
                changeFilters({ ...filters, layout: option.layout, categoryIds: [] })
              }
              className={`rounded-lg px-3 py-1.5 ${
                filters.layout === option.layout
                  ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-fg)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Link
          href="/projects/new"
          data-component="NewProjectAction"
          className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          New project
        </Link>
      </div>

      <ProjectsFilters value={filters} onChange={changeFilters} />

      {board ? null : (
        <ProjectsCategoryFilter
          categories={categories}
          value={filters.categoryIds}
          onChange={(categoryIds) => changeFilters({ ...filters, categoryIds })}
        />
      )}

      {error ? (
        <p
          data-component="ProjectsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {error}
        </p>
      ) : null}

      {board ? (
        <>
          <div className="flex items-center justify-end">
            <button
              type="button"
              data-component="ManageCategoriesAction"
              onClick={() => setManaging(true)}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs"
            >
              Manage categories
            </button>
          </div>
          <ProjectsCategoryBoard
            items={items}
            categories={categories}
            onMoved={onMoved}
            onOpenList={openCategoryList}
          />
          <div className="flex items-center justify-center py-2 text-xs text-[var(--color-muted)]">
            {loading ? (
              <span>Loading…</span>
            ) : cursor ? (
              <span>
                Showing the first {items.length} projects — narrow the view or
                search to see the rest.
              </span>
            ) : null}
          </div>
          {managing ? (
            <ProjectCategoriesSheet
              categories={categories}
              onClose={closeManaging}
              onChanged={onCategoriesChanged}
            />
          ) : null}
        </>
      ) : items.length === 0 && !loading ? (
        <div
          data-component="ProjectsEmpty"
          className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          <p>
            {narrowed || filters.q
              ? "Nothing matches that view."
              : "No projects yet. Anything the agent works on over time — a deliverable, a recurring job, a standing duty — lives here. Create one, let the agent draft its plan, and run it from this app."}
          </p>
          {!narrowed && !filters.q ? (
            <Link
              href="/projects/new"
              data-component="NewProjectAction"
              className="self-start rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
            >
              New project
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <ProjectsBulkBar
            selected={selectedItems}
            pageItems={pageItems}
            categories={categories}
            onSelectPage={selectPage}
            onClear={() => setSelected(new Set())}
            onDone={onBulkDone}
          />
          <ul className="flex flex-col gap-2">
            {pageItems.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                categories={categories}
                selection={{
                  checked: selected.has(project.slug),
                  onToggle: () => toggleSelected(project.slug),
                }}
              />
            ))}
          </ul>
          <ProjectsPagination
            page={currentPage}
            pageSize={pageSize}
            total={items.length}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </>
      )}

      {board ? null : (
        <div className="flex items-center justify-center py-2 text-xs text-[var(--color-muted)]">
          {loading ? (
            <span>Loading…</span>
          ) : cursor ? (
            <span>
              Showing the first {items.length} projects — narrow the view or
              search to see the rest.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
