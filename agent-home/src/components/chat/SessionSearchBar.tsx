"use client";

import { useState, useCallback } from "react";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";

import { Spinner } from "@/components/ui/Spinner";

import { SearchNav } from "./SearchNav";

interface SearchResult {
  session_id: string;
  snippet: string;
  role: string;
  title?: string | null;
  session_started?: number;
}

/**
 * Cross-session keyword search. Shows a search input; on submit, queries the
 * BFF search endpoint. Results are listed as snippets; tapping one switches
 * to that session. The SearchNav bar lets the user jump between matches.
 */
export function SessionSearchBar({
  onSearch,
  onJumpToResult,
  onClose,
}: {
  onSearch: (q: string) => Promise<SearchResult[]>;
  onJumpToResult: (result: SearchResult, index: number, total: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showResults, setShowResults] = useState(false);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setShowResults(true);
    try {
      const res = await onSearch(q);
      setResults(res);
      setCurrentIndex(0);
    } finally {
      setLoading(false);
    }
  }, [query, onSearch]);

  const { run: searchOnce } = useAction(search);

  const jump = useCallback(
    (dir: 1 | -1) => {
      if (results.length === 0) return;
      const next = (currentIndex + dir + results.length) % results.length;
      setCurrentIndex(next);
      onJumpToResult(results[next], next, results.length);
    },
    [currentIndex, results, onJumpToResult],
  );

  return (
    <div
      data-component="SessionSearchBar"
      aria-busy={loading}
      className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void searchOnce();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Search all sessions…"
          className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
        />
        {showResults && results.length > 0 && (
          <SearchNav
            current={currentIndex}
            total={results.length}
            onPrev={() => jump(-1)}
            onNext={() => jump(1)}
            onClose={onClose}
          />
        )}
        {!showResults && (
          <ActionButton
            onAction={searchOnce}
            busy={loading}
            disabled={!query.trim()}
            busyLabel="Searching…"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted)] disabled:opacity-60"
          >
            Go
          </ActionButton>
        )}
      </div>
      {showResults && results.length > 0 && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)]">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setCurrentIndex(i);
                onJumpToResult(r, i, results.length);
              }}
              className={`flex w-full flex-col items-start gap-0.5 border-b border-[var(--color-border)] px-3 py-1.5 text-left last:border-b-0 ${
                i === currentIndex ? "bg-[var(--color-surface-2)]" : ""
              }`}
            >
              <span className="text-xs font-medium text-[var(--color-fg)]">
                {r.title || r.session_id.slice(0, 12)}
              </span>
              <span
                className="text-xs text-[var(--color-muted)]"
                dangerouslySetInnerHTML={{
                  __html: r.snippet
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/&gt;&gt;&gt;/g, '<mark class="bg-[var(--color-accent)] text-[var(--color-accent-fg)] rounded px-0.5">')
                    .replace(/&lt;&lt;&lt;/g, "</mark>"),
                }}
              />
            </button>
          ))}
        </div>
      )}
      {/* A cross-session keyword search reads every conversation, so it is one
       * of the slowest things in Chat — it says so rather than looking idle. */}
      {showResults && loading && (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 inline-flex items-center gap-2 text-xs text-[var(--color-accent)]"
        >
          <Spinner />
          Searching every conversation…
        </p>
      )}
      {showResults && results.length === 0 && !loading && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">No matches found.</p>
      )}
    </div>
  );
}
