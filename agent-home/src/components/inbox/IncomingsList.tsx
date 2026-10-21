"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/ActionButton";

import { IncomingRow } from "@/components/inbox/IncomingRow";
import {
  EMPTY_FILTERS,
  IncomingsFilters,
  filtersFromParams,
  filtersToParams,
  type IncomingsFilterState,
} from "@/components/inbox/IncomingsFilters";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Spinner } from "@/components/ui/Spinner";
import type { IncomingItem, IncomingsFacets, IncomingsResponse } from "@/types";

const PAGE_SIZE = 50;

/**
 * Everything that arrived, newest first, across every channel.
 *
 * Paging is keyset: the next page continues after the last row the reader saw,
 * so an arrival landing mid-scroll cannot shift a page boundary and show the
 * same message twice. The filters round-trip through the URL — a colleague
 * opening `?q=invoice&surface=email` sees the same *filter*, never the same
 * scroll position, which is why the cursor never goes in the address bar.
 */
export function IncomingsList({
  initial,
  facets,
}: {
  initial: IncomingsResponse;
  facets: IncomingsFacets;
}) {
  const [items, setItems] = useState<IncomingItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  // A shared URL is a shared filter, so the state starts from the address bar.
  // Read lazily during the first render rather than in an effect: the server
  // render has no `window`, and restoring afterwards would flash the unfiltered
  // list before the filters applied.
  const [filters, setFilters] = useState<IncomingsFilterState>(() =>
    typeof window === "undefined"
      ? EMPTY_FILTERS
      : filtersFromParams(new URLSearchParams(window.location.search)),
  );
  const [loading, setLoading] = useState(false);
  // A filter change *replaces* the list, so the rows on screen are about to
  // become wrong and are covered while the query runs. Paging with a cursor
  // only *appends*, and the rows above stay valid — that one gets a spinner at
  // the end of the list instead of an overlay over rows the user is reading.
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (value: IncomingsFilterState, after: string | null) => {
      setLoading(true);
      setReplacing(after == null);
      setError(null);
      try {
        const params = filtersToParams(value, after);
        params.set("limit", String(PAGE_SIZE));
        const res = await fetch(`/api/incomings?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Your session expired — sign in again."
              : "Couldn't load your inbox.",
          );
          return;
        }
        const body = (await res.json()) as IncomingsResponse;
        setItems((prev) => (after ? [...prev, ...body.items] : body.items));
        setCursor(body.next_cursor);
      } catch {
        setError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
        setReplacing(false);
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
      const tab = params.toString() ? `?tab=incomings&${params}` : "?tab=incomings";
      window.history.replaceState(null, "", `/inbox${tab}`);
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

  const filtered =
    filters.q ||
    filters.surfaces.length > 0 ||
    filters.includeTags.length > 0 ||
    filters.excludeTags.length > 0 ||
    filters.hasAttachments ||
    filters.remembered != null ||
    filters.since ||
    filters.until;

  return (
    <div data-component="IncomingsList" className="flex flex-col gap-3">
      <IncomingsFilters facets={facets} value={filters} onChange={setFilters} />

      <BusyRegion busy={replacing} label="Filtering your inbox…">
        <div className="flex flex-col gap-3">
          {error ? (
            <p
              data-component="IncomingsError"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
            >
              {error}
            </p>
          ) : items.length === 0 && !loading ? (
            <p
              data-component="IncomingsEmpty"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
            >
              {filtered
                ? "Nothing matches those filters."
                : "Nothing has arrived yet. WhatsApp messages, emails and calendar events land here as they come in."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <IncomingRow key={item.id} item={item} />
              ))}
            </ul>
          )}

          <div ref={sentinel} aria-hidden className="h-px" />

          <div className="flex items-center justify-center py-2 text-xs text-[var(--color-muted)]">
            {loading ? (
              <span className="inline-flex items-center gap-2 text-[var(--color-accent)]">
                <Spinner />
                Loading…
              </span>
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
      </BusyRegion>
    </div>
  );
}
