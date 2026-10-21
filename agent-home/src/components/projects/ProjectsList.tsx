"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the visible list re-reads its first page — project statuses,
 * health and next-run move without anyone touching this page. */
const AUTO_REFRESH_MS = 30_000;

import { ActionButton } from "@/components/projects/ActionButton";
import { ProjectRow } from "@/components/projects/ProjectRow";
import { ProjectsFilters } from "@/components/projects/ProjectsFilters";
import {
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
  type ProjectsFilterState,
} from "@/components/projects/filters";
import { useAction } from "@/lib/use-action";
import type { ProjectListItem, ProjectsResponse } from "@/types";

const PAGE_SIZE = 50;

/**
 * The project list: everything the agent is working on, running on a
 * schedule, or standing watch over.
 *
 * Same contract as the to-do list: keyset paging, filters round-trip through
 * the URL (the cursor never does), and the first page is the server's — so
 * the debounce arms on the first interaction instead of refetching the page
 * that just rendered.
 */
export function ProjectsList({ initial }: { initial: ProjectsResponse }) {
  const [items, setItems] = useState<ProjectListItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  // The server rendered from the same URL, so the state starts from the
  // address bar rather than from an effect that would flash the default view.
  const [filters, setFilters] = useState<ProjectsFilterState>(() =>
    typeof window === "undefined"
      ? EMPTY_FILTERS
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
      // A fresh first page (filters changed, auto-refresh) resets the flag;
      // appending a deeper page sets it.
      setPaged(after !== null);
      try {
        const params = filtersToParams(value, after);
        params.set("limit", String(PAGE_SIZE));
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
        setItems((prev) => (after ? [...prev, ...body.items] : body.items));
        setCursor(body.next_cursor);
      } catch {
        setError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [],
  );

  const armed = useRef(false);
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      return;
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
  // the first page on a cadence while the tab is visible and the moment
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
    };
    const interval = window.setInterval(tick, AUTO_REFRESH_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [filters, paged, fetchPage]);

  // Infinite scroll, with the button below as the accessible fallback for
  // keyboard users and for browsers where the sentinel never intersects.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || cursor == null || typeof IntersectionObserver === "undefined") {
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

  const narrowed = filters !== EMPTY_FILTERS && filters.view !== "active";


  // The button is swapped for "Loading…" only after a render; the lock
  // stops a fast second click from fetching the same page twice.
  const { run: loadMore } = useAction(() => fetchPage(filters, cursor));

  return (
    <div data-component="ProjectsList" className="flex flex-col gap-3">
      {/* The create door (§13): the feature is unreachable if its only
          entrance is a CLI verb. */}
      <div className="flex items-center justify-end">
        <Link
          href="/projects/new"
          data-component="NewProjectAction"
          className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          New project
        </Link>
      </div>

      <ProjectsFilters value={filters} onChange={setFilters} />

      {error ? (
        <p
          data-component="ProjectsError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {error}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
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

      <div ref={sentinel} aria-hidden className="h-px" />

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
    </div>
  );
}
