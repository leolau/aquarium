"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MemoryMap } from "@/components/memory/MemoryMap";
import { describeSource, sourceLink } from "@/components/memory/citation";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Spinner } from "@/components/ui/Spinner";
import type {
  MemoryProjection,
  MemoryQueryPlacement,
  MemoryRow,
  MemoryRowsResponse,
  MemorySummary,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * FG-23 A2/A4 — the phone memory view. Server-rendered with the first page of
 * rows; search, paging, the map and query placement are client-side refetches
 * through the BFF handlers under `src/app/api/memory/*`.
 *
 * Layout: one column on a phone, and from `xl` up the search box and the list
 * become their own panel beside the map, scrolling independently. On a wide
 * screen the stacked version forced a scroll between "where is this memory"
 * and "what does it say", which are the two halves of the same question.
 *
 * Read-only: no write, delete, re-embed or forget path exists on this surface.
 */
export function MemoryView({
  summary,
  initialRows,
  documentId = null,
}: {
  summary: MemorySummary;
  initialRows: MemoryRowsResponse;
  /** `?document=<id>`: open on that document's passages (a citation link). */
  documentId?: string | null;
}) {
  const [rows, setRows] = useState<MemoryRow[]>(initialRows.rows);
  const [total, setTotal] = useState(initialRows.total);
  const [offset, setOffset] = useState(initialRows.offset);
  const [limit] = useState(initialRows.limit);
  const [q, setQ] = useState("");
  const [browse, setBrowse] = useState<BrowseKind>(
    documentId ? "chunk" : "memory",
  );
  // A citation link (`?document=`) narrows the list to one document's
  // passages until the reader clears it.
  const [docFilter, setDocFilter] = useState<string | null>(documentId);
  const [loading, setLoading] = useState(false);
  // A search or a corpus switch *replaces* the rows, so the list is covered
  // while it runs. "Load more" only appends and the rows above stay valid, so
  // that one keeps its inline button spinner instead.
  const [replacing, setReplacing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);

  // --- Search (debounced 300 ms, offset reset to 0) -----------------------
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server already rendered the first page, so the debounce must not fire
  // on mount: it would refetch identical rows over mobile data and flash the
  // list. It arms on the first keystroke.
  const searchArmed = useRef(false);
  const doSearch = useCallback(
    async (
      query: string,
      kind: BrowseKind = browse,
      doc: string | null = docFilter,
    ) => {
      setLoading(true);
      setReplacing(true);
      setSearching(!!query.trim());
      setRowsError(null);
      try {
        const sp = new URLSearchParams();
        if (query.trim()) sp.set("q", query.trim());
        if (kind === "chunk") {
          sp.set("kind", "chunk");
          // For chunks the explorer reads `topic` as the document filter.
          if (doc) sp.set("topic", doc);
        }
        sp.set("limit", String(limit));
        sp.set("offset", "0");
        const res = await fetch(`/api/memory/rows?${sp.toString()}`);
        if (!res.ok) {
          setRowsError(describeFailure(res.status));
          return;
        }
        const data: MemoryRowsResponse = await res.json();
        setRows(data.rows);
        setTotal(data.total);
        setOffset(0);
      } catch {
        setRowsError("Couldn't reach the AI layer.");
      } finally {
        setLoading(false);
        setReplacing(false);
      }
    },
    [limit, browse, docFilter],
  );

  const switchBrowse = useCallback(
    (kind: BrowseKind) => {
      if (kind === browse) return;
      setBrowse(kind);
      searchArmed.current = true;
      void doSearch(q, kind, docFilter);
    },
    [browse, doSearch, q, docFilter],
  );

  const clearDocFilter = useCallback(() => {
    setDocFilter(null);
    searchArmed.current = true;
    void doSearch(q, "chunk", null);
  }, [doSearch, q]);

  useEffect(() => {
    if (!searchArmed.current) {
      searchArmed.current = true;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(q), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, doSearch]);

  // --- Load more ----------------------------------------------------------
  const loadMore = useCallback(async () => {
    const nextOffset = offset + limit;
    if (nextOffset >= total) return;
    setLoading(true);
    setRowsError(null);
    try {
      const sp = new URLSearchParams();
      if (q.trim()) sp.set("q", q.trim());
      if (browse === "chunk") {
        sp.set("kind", "chunk");
        if (docFilter) sp.set("topic", docFilter);
      }
      sp.set("limit", String(limit));
      sp.set("offset", String(nextOffset));
      const res = await fetch(`/api/memory/rows?${sp.toString()}`);
      if (!res.ok) {
        setRowsError(describeFailure(res.status));
        return;
      }
      const data: MemoryRowsResponse = await res.json();
      setRows((prev) => [...prev, ...data.rows]);
      setOffset(nextOffset);
    } catch {
      setRowsError("Couldn't reach the AI layer.");
    } finally {
      setLoading(false);
    }
  }, [offset, limit, total, q, browse, docFilter]);

  // --- Map (fetched after first paint) ------------------------------------
  const [projection, setProjection] = useState<MemoryProjection | null>(null);
  const [projectionError, setProjectionError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/memory/projection");
        if (!res.ok) {
          if (!cancelled) setProjectionError(true);
          return;
        }
        const data: MemoryProjection = await res.json();
        if (!cancelled) setProjection(data);
      } catch {
        if (!cancelled) setProjectionError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Query placement (A4) ----------------------------------------------
  const [queryText, setQueryText] = useState("");
  const [queryResult, setQueryResult] = useState<MemoryQueryPlacement | null>(
    null,
  );
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  const placeQuery = useCallback(async () => {
    if (!queryText.trim()) return;
    setQueryLoading(true);
    setQueryError(null);
    try {
      const res = await fetch("/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: queryText.trim() }),
      });
      if (!res.ok) {
        // 429 is the upstream's own rate limit (one placement every 3 s).
        setQueryError(
          res.status === 429
            ? "One placement every few seconds \u2014 try again shortly."
            : describeFailure(res.status),
        );
        return;
      }
      const data: MemoryQueryPlacement = await res.json();
      setQueryResult(data);
    } catch {
      setQueryError("Couldn't reach the AI layer.");
    } finally {
      setQueryLoading(false);
    }
  }, [queryText]);

  // --- Row lookup for nearest neighbours ----------------------------------
  const rowMap = new Map(rows.map((r) => [r.id, r]));

  return (
    <div
      data-component="MemoryView"
      className="space-y-4 xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-6 xl:space-y-0"
    >
      <div className="min-w-0 space-y-4">
      {/* Pills */}
      <div className="flex flex-wrap gap-2">
        <Pill label="memories" value={summary.totals.memories} />
        <Pill
          label="never recalled"
          value={summary.recall_use.never_used}
        />
        {summary.totals.documents > 0 && (
          <Pill label="documents" value={summary.totals.documents} />
        )}
      </div>

      {/* Map */}
      {projection ? (
        <MemoryMap projection={projection} queryResult={queryResult} />
      ) : projectionError ? null : (
        <div className="h-40 animate-pulse rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
      )}

      {/* Query placement (A4) */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") placeQuery();
            }}
            placeholder="Place a query on the map…"
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <ActionButton
            onAction={placeQuery}
            disabled={queryLoading || !queryText.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {queryLoading ? (
              <>
                <Spinner />
                <span className="sr-only">Placing your query…</span>
              </>
            ) : (
              "Place"
            )}
          </ActionButton>
        </div>
        {queryText.trim() && (
          <p className="text-xs text-[var(--color-muted)]">
            Your query is never stored — it&apos;s embedded and discarded.
          </p>
        )}
        {queryError && (
          <p data-component="MemoryQueryError" className="text-xs text-[var(--color-accent)]">
            {queryError}
          </p>
        )}
        {queryResult && (
          <QueryResultView
            result={queryResult}
            rowMap={rowMap}
          />
        )}
      </div>
      </div>

      {/* Panel: search + list. Its own scroll container from `xl` up, so the
          map stays in view while the list is paged. */}
      <aside
        data-component="MemoryListPanel"
        className="space-y-3 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-9rem)] xl:overflow-y-auto xl:pr-1"
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            browse === "chunk" ? "Search documents…" : "Search memories…"
          }
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />

        {summary.totals.documents > 0 && (
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-1 text-xs">
            <BrowseTab
              active={browse === "memory"}
              onClick={() => switchBrowse("memory")}
              label="Memories"
            />
            <BrowseTab
              active={browse === "chunk"}
              onClick={() => switchBrowse("chunk")}
              label="Documents"
            />
          </div>
        )}
        {docFilter && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--color-surface)] px-2 py-1 text-xs">
            <span className="truncate">
              {rows[0]?.document_title || "One document"}
            </span>
            <button
              type="button"
              onClick={clearDocFilter}
              className="shrink-0 text-[var(--color-accent)]"
            >
              Show all
            </button>
          </div>
        )}
        {browse === "chunk" && q.trim() && (
          <p className="text-xs text-[var(--color-muted)]">
            Document chunks are listed newest first — typed text doesn&apos;t
            filter them. Use the map&apos;s query box to find them by meaning.
          </p>
        )}

        {/* Rows */}
        {rowsError && (
          <p data-component="MemoryRowsError" className="text-xs text-[var(--color-accent)]">
            {rowsError}
          </p>
        )}
        <BusyRegion busy={replacing} label="Searching your memory…">
          <div className="space-y-2">
            {rows.length === 0 && !loading ? (
              <div className="py-8 text-center text-sm text-[var(--color-muted)]">
                {searching
                  ? "No memories matched your search."
                  : "No memories visible in your scope yet."}
              </div>
            ) : (
              rows.map((row) => <MemoryCard key={row.id} row={row} />)
            )}
          </div>
        </BusyRegion>

        {/* Load more */}
        {offset + limit < total && (
          <ActionButton
            onAction={loadMore}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-muted)] disabled:opacity-40"
          >
            {loading ? (
              <>
                <Spinner />
                Loading…
              </>
            ) : (
              "Load more"
            )}
          </ActionButton>
        )}
      </aside>
    </div>
  );
}

/** Which corpus the list panel is browsing. */
type BrowseKind = "memory" | "chunk";

function BrowseTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded px-2 py-1 ${
        active
          ? "bg-[var(--color-surface)] font-medium"
          : "text-[var(--color-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

/** A failed BFF call in words a phone user can act on. */
export function describeFailure(status: number): string {
  if (status === 401) return "Your session expired \u2014 sign in again.";
  if (status === 403) return "You don't have access to this memory.";
  if (status === 409) return "Your login isn't linked to a memory principal.";
  return "Couldn't load memories right now.";
}

function Pill({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs">
      <span className="font-semibold">{value}</span>{" "}
      <span className="text-[var(--color-muted)]">{label}</span>
    </span>
  );
}

function MemoryCard({ row }: { row: MemoryRow }) {
  const source = describeSource(row);
  const link = sourceLink(row);
  return (
    <div
      data-component="MemoryCard"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <p className="text-sm leading-relaxed">
        {row.text}
        {row.truncated && <span className="text-[var(--color-muted)]"> …</span>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
        {row.topic && (
          <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">
            {row.topic}
          </span>
        )}
        <span>uses: {row.uses}</span>
        {row.last_used && <span>· {relativeTime(row.last_used)}</span>}
        {row.score != null && (
          <span>· score: {row.score.toFixed(3)}</span>
        )}
        {row.elevated && row.provenance && (
          <span className="text-[var(--color-accent)]">
            · {row.provenance}
          </span>
        )}
      </div>
      {source && (
        <p
          data-component="MemoryCardSource"
          className="mt-1 truncate text-xs text-[var(--color-muted)]"
          title={source.detail ?? source.label}
        >
          {link ? (
            <a
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              className="underline decoration-dotted underline-offset-2"
            >
              {source.label}
            </a>
          ) : (
            source.label
          )}
        </p>
      )}
    </div>
  );
}

function QueryResultView({
  result,
  rowMap,
}: {
  result: MemoryQueryPlacement;
  rowMap: Map<string, MemoryRow>;
}) {
  if (result.degraded) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
        <p className="text-[var(--color-muted)]">
          The map has no place for this query (UMAP basis unavailable), but
          here are the nearest memories by meaning:
        </p>
        <NearestList nearest={result.nearest} rowMap={rowMap} />
      </div>
    );
  }
  if (result.x == null || result.y == null) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
      <p className="text-[var(--color-muted)]">
        Query placed at ({result.x.toFixed(1)}, {result.y.toFixed(1)}).
      </p>
      <NearestList nearest={result.nearest} rowMap={rowMap} />
    </div>
  );
}

function NearestList({
  nearest,
  rowMap,
}: {
  nearest: { id: string; score: number }[];
  rowMap: Map<string, MemoryRow>;
}) {
  if (nearest.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {nearest.slice(0, 5).map((n) => {
        const row = rowMap.get(n.id);
        return (
          <li key={n.id} className="flex items-baseline gap-2 text-xs">
            <span className="font-mono text-[var(--color-muted)]">
              {n.score.toFixed(3)}
            </span>
            <span className="truncate">
              {row ? row.text.slice(0, 80) : "(a memory outside the loaded list)"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
