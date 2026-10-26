"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the visible list re-reads its first page — project statuses,
 * health and next-run move without anyone touching this page. */
const AUTO_REFRESH_MS = 30_000;

import { ActionButton } from "@/components/projects/ActionButton";
import { ProjectRow } from "@/components/projects/ProjectRow";
import { ProjectsFilters } from "@/components/projects/ProjectsFilters";
import { ProjectCategoriesSheet } from "@/components/projects/categories/ProjectCategoriesSheet";
import { ProjectsCategoryBoard } from "@/components/projects/categories/ProjectsCategoryBoard";
import { fetchProjectCategories } from "@/components/projects/categories/useProjectCategories";
import {
  EMPTY_FILTERS,
  UNCATEGORIZED_FILTER,
  filtersFromParams,
  filtersToParams,
  type ProjectsFilterState,
  type ProjectsLayout,
} from "@/components/projects/filters";
import { useAction } from "@/lib/use-action";
import type {
  ProjectCategory,
  ProjectListItem,
  ProjectsResponse,
} from "@/types";

const PAGE_SIZE = 50;

/** The board shows every matching project, read in the API's largest page
 * size and capped so a huge instance can't fetch forever. */
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
 * Same contract as the to-do list: keyset paging, filters round-trip through
 * the URL (the cursor never does), and the first page is the server's — so
 * the debounce arms on the first interaction instead of refetching the page
 * that just rendered.
 *
 * The category board is the default layout (`layout=list` swaps it for the
 * paged list). It needs every matching project rather than page 1: it reads
 * all pages (up to `BOARD_CAP`), and the auto-refresh re-reads all of them
 * together with the categories. A board tile's List button opens the list
 * narrowed to that category (`layout=list&category=<id|none>`).
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
  // True once the user has appended a page beyond the server's first. An
  // auto-refresh replaces the first page only, so it would silently drop
  // everything below — polling pauses in that state instead.
  const [paged, setPaged] = useState(false);
  // Mirrors `loading` for the interval callback (which must not re-arm on
  // every fetch or the cadence would never settle). Written only inside
  // `fetchPage` — assigning a ref during render is off-limits.
  const loadingRef = useRef(false);

  const fetchPage = useCallback(
    async (value: ProjectsFilterState, after: string | null) => {
      setLoading(true);
      loadingRef.current = true;
      setError(null);
      const board = value.layout === "board";
      // A fresh first page (filters changed, auto-refresh) resets the flag;
      // appending a deeper page sets it. The board always reads everything.
      setPaged(!board && after !== null);
      try {
        // The board walks every page from the top; the list reads one.
        let next: string | null = board ? null : after;
        let collected: ProjectListItem[] = [];
        do {
          const params = filtersToParams(value, next);
          // A view preference, not a filter: never sent upstream.
          params.delete("layout");
          params.set("limit", String(board ? BOARD_PAGE_SIZE : PAGE_SIZE));
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
        } while (board && next && collected.length < BOARD_CAP);
        if (board) {
          setItems(collected.slice(0, BOARD_CAP));
        } else {
          setItems((prev) => (after ? [...prev, ...collected] : collected));
        }
        // On the board a cursor left over means the cap cut the read short.
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
  // A board URL opened directly: the server sent page 1 only, so the first
  // pass reads the rest instead of skipping.
  const boardNeedsRest = useRef(initial.next_cursor !== null);
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      if (!(filters.layout === "board" && boardNeedsRest.current)) return;
    }
    const timer = setTimeout(() => {
      const params = filtersToParams(filters);
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        query ? `/projects?${query}` : "/projects",
      );
      void fetchPage(filters, null);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, fetchPage]);

  // Live list: health, status and next-run move without a reload. Re-read
  // the first page (the board: every page) on a cadence while the tab is visible and the moment
  // focus returns — the same pattern the chat unread badge uses. Paused
  // while the user has paged deeper (a refresh would drop appended pages)
  // and skipped while a fetch is already in flight.
  useEffect(() => {
    if (paged) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || loadingRef.current) {
        return;
      }
      void fetchPage(filters, null);
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
  }, [filters, paged, fetchPage, reloadCategories]);

  // Infinite scroll, with the button below as the accessible fallback for
  // keyboard users and for browsers where the sentinel never intersects.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (
      !node ||
      cursor == null ||
      filters.layout === "board" ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) {
        void fetchPage(filters, cursor);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, filters, loading, fetchPage]);

  const narrowed =
    filters !== EMPTY_FILTERS &&
    (filters.view !== "active" || filters.category !== "");
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
      void fetchPage(filters, null);
    },
    [filters, fetchPage],
  );

  // Closing the sheet re-reads both, so the board can never keep showing a
  // list from before the edits (e.g. a re-read inside the sheet failed).
  const closeManaging = useCallback(() => {
    setManaging(false);
    void reloadCategories();
    void fetchPage(filters, null);
  }, [filters, fetchPage, reloadCategories]);

  const openCategoryList = useCallback(
    (categoryId: string | null) => {
      setFilters({
        ...filters,
        layout: "list",
        category: categoryId ?? UNCATEGORIZED_FILTER,
      });
    },
    [filters],
  );

  const listCategory =
    filters.layout === "list" && filters.category
      ? filters.category === UNCATEGORIZED_FILTER
        ? { name: "Uncategorized", color: null }
        : (categories.find((c) => c.id === filters.category) ?? {
            name: "Unknown category",
            color: null,
          })
      : null;

  // The button is swapped for "Loading…" only after a render; the lock
  // stops a fast second click from fetching the same page twice.
  const { run: loadMore } = useAction(() => fetchPage(filters, cursor));

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
                setFilters({ ...filters, layout: option.layout, category: "" })
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

      <ProjectsFilters value={filters} onChange={setFilters} />

      {listCategory ? (
        <div
          data-component="ProjectsCategoryFilter"
          className="flex items-center gap-2 text-xs"
        >
          <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--color-accent)] px-2 py-1 text-[var(--color-accent)]">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor: listCategory.color ?? "var(--color-muted)",
              }}
            />
            <span className="truncate">Category: {listCategory.name}</span>
          </span>
          <button
            type="button"
            aria-label="Show every category"
            onClick={() => setFilters({ ...filters, category: "" })}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)]"
          >
            Clear
          </button>
        </div>
      ) : null}

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
        <ul className="flex flex-col gap-2">
          {items.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </ul>
      )}

      {board ? null : (
        <div ref={sentinel} aria-hidden className="h-px" />
      )}

      {board ? null : (
      <div className="flex items-center justify-center py-2 text-xs text-[var(--color-muted)]">
        {loading ? (
          <span>Loading…</span>
        ) : cursor ? (
          <ActionButton
            busy={false}
            onClick={() => void loadMore()}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
          >
            Load more
          </ActionButton>
        ) : items.length > 0 ? (
          <span>That&apos;s everything.</span>
        ) : null}
      </div>
      )}
    </div>
  );
}
