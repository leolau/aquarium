"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TodoRow } from "@/components/todos/TodoRow";
import { ActionButton } from "@/components/ui/ActionButton";
import { TodosFilters } from "@/components/todos/TodosFilters";
import {
  EMPTY_FILTERS,
  filtersFromParams,
  filtersToParams,
  type TodosFilterState,
} from "@/components/todos/filters";
import type { Todo, TodoStage, TodosFacets, TodosResponse } from "@/types";

const PAGE_SIZE = 50;

/**
 * The to-do list: what the agent noticed, and what the user decided about it.
 *
 * Paging is keyset and the filters round-trip through the URL, exactly as in
 * the inbox — a shared `/todos?stage=open` link is a shared *filter*, never
 * somebody's scroll position, which is why the cursor never reaches the
 * address bar.
 *
 * A stage change is applied optimistically and then reconciled with the row
 * the server returns. The alternative — waiting on the round trip — makes
 * dismissing five staged to-dos feel like five decisions instead of one sweep,
 * and clearing the noise has to be cheaper than reading it.
 */
export function TodosList({
  initial,
  facets,
}: {
  initial: TodosResponse;
  facets: TodosFacets;
}) {
  const [items, setItems] = useState<Todo[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  // The server rendered from the same URL, so the state starts from the
  // address bar rather than from an effect that would flash the default view.
  const [filters, setFilters] = useState<TodosFilterState>(() =>
    typeof window === "undefined"
      ? EMPTY_FILTERS
      : filtersFromParams(new URLSearchParams(window.location.search)),
  );
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (value: TodosFilterState, after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = filtersToParams(value, after);
        params.set("limit", String(PAGE_SIZE));
        const res = await fetch(`/api/todos?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Your session expired — sign in again."
              : "Couldn't load your to-dos.",
          );
          return;
        }
        const body = (await res.json()) as TodosResponse;
        setItems((prev) => (after ? [...prev, ...body.items] : body.items));
        setCursor(body.next_cursor);
      } catch {
        setError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const setStage = useCallback(
    async (todo: Todo, stage: TodoStage) => {
      const before = todo.stage;
      setPending(todo.id);
      setItems((prev) =>
        prev.map((row) => (row.id === todo.id ? { ...row, stage } : row)),
      );
      try {
        const res = await fetch(
          `/api/todos/${encodeURIComponent(todo.id)}/stage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ stage }),
          },
        );
        if (!res.ok) throw new Error("stage");
        const updated = (await res.json()) as Todo;
        setItems((prev) =>
          prev.map((row) => (row.id === todo.id ? updated : row)),
        );
      } catch {
        // Put it back: a to-do that silently stayed where it was, while the
        // list says otherwise, is worse than an error.
        setItems((prev) =>
          prev.map((row) =>
            row.id === todo.id ? { ...row, stage: before } : row,
          ),
        );
        setError("That didn't stick — try again.");
      } finally {
        setPending(null);
      }
    },
    [],
  );

  // The server rendered the first page, so the debounce must not fire on mount
  // and refetch identical rows; it arms on the first interaction.
  const armed = useRef(false);
  useEffect(() => {
    if (!armed.current) {
      armed.current = true;
      return;
    }
    const timer = setTimeout(() => {
      const params = filtersToParams(filters);
      const query = params.toString();
      window.history.replaceState(null, "", query ? `/todos?${query}` : "/todos");
      void fetchPage(filters, null);
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, fetchPage]);

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

  const narrowed =
    filters.q ||
    filters.priorities.length > 0 ||
    filters.sourceRef ||
    filters.stages.length !== EMPTY_FILTERS.stages.length;

  return (
    <div data-component="TodosList" className="flex flex-col gap-3">
      <TodosFilters facets={facets} value={filters} onChange={setFilters} />

      {error ? (
        <p
          data-component="TodosError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {error}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
        <p
          data-component="TodosEmpty"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          {narrowed
            ? "Nothing matches those filters."
            : "Nothing to do. As messages arrive, anything that looks like it needs you lands here first."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onStage={setStage}
              busy={pending === todo.id}
            />
          ))}
        </ul>
      )}

      <div ref={sentinel} aria-hidden className="h-px" />

      <div className="flex items-center justify-center py-2 text-xs text-[var(--color-muted)]">
        {loading ? (
          <span>Loading…</span>
        ) : cursor ? (
          <ActionButton
            onAction={() => fetchPage(filters, cursor)}
            busyLabel="Loading…"
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
