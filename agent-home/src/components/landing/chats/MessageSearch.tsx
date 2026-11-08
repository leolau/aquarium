"use client";

import { useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";

/** One hit from `GET /api/chat/sessions/search` (snippet marks matches with `>>>…<<<`). */
export interface MessageSearchHit {
  session_id: string;
  snippet: string;
  role: string;
  title?: string | null;
}

export type MessageSearchFn = (query: string, signal: AbortSignal) => Promise<MessageSearchHit[]>;

/** Wait for a typing pause before searching every transcript (it is slow). */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 350;
/** Shorter queries match almost everything, so they are not sent. */
export const MESSAGE_SEARCH_MIN_CHARS = 2;

interface Settled {
  query: string;
  hits: MessageSearchHit[];
  failed: boolean;
}

/**
 * Debounced all-sessions message search. Stale answers (the query moved on,
 * or the panel unmounted) are aborted and dropped; the last settled hits stay
 * on screen while the next search runs.
 */
export function useMessageSearch(query: string, search: MessageSearchFn | undefined) {
  const q = query.trim();
  const ready = Boolean(search) && q.length >= MESSAGE_SEARCH_MIN_CHARS;
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const run = searchRef.current;
      if (!run) return;
      run(q, ctrl.signal).then(
        (hits) => {
          if (!ctrl.signal.aborted) setSettled({ query: q, hits, failed: false });
        },
        () => {
          if (!ctrl.signal.aborted) setSettled({ query: q, hits: [], failed: true });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, ready, attempt]);

  const current = settled?.query === q ? settled : null;
  return {
    ready,
    loading: ready && !current,
    failed: ready && Boolean(current?.failed),
    hits: ready && settled && !settled.failed ? settled.hits : [],
    retry: () => {
      setSettled(null);
      setAttempt((n) => n + 1);
    },
  };
}

/** Renders `>>>match<<<` as `<mark>` without injecting HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(>>>[\s\S]*?<<<)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith(">>>") && part.endsWith("<<<") ? (
          <mark
            key={i}
            className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-0.5 text-[var(--color-accent-fg)]"
          >
            {part.slice(3, -3)}
          </mark>
        ) : (
          <span key={i}>{part.replace(/>>>|<<</g, "")}</span>
        ),
      )}
    </>
  );
}

/**
 * "In messages": the sidebar search's all-sessions half (searches inside
 * every transcript, not just titles). Tapping a hit opens that chat with the
 * match highlighted.
 */
export function MessageSearchSection({
  query,
  search,
  onOpen,
  onNavigate,
}: {
  query: string;
  search: MessageSearchFn;
  onOpen: (hit: MessageSearchHit) => void;
  onNavigate?: () => void;
}) {
  const t = useT("chatPage");
  const { ready, loading, failed, hits, retry } = useMessageSearch(query, search);
  const q = query.trim();

  return (
    <section
      aria-label={t("messageSearch.heading")}
      data-component="MessageSearchResults"
      aria-busy={loading}
      className="flex flex-col"
    >
      <h3 className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase leading-[14px] tracking-wide text-[var(--color-muted)]">
        {t("messageSearch.heading")}
        {ready && !loading && !failed && hits.length ? <span>{hits.length}</span> : null}
      </h3>
      {!ready ? (
        <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
          {t("messageSearch.hint", { min: MESSAGE_SEARCH_MIN_CHARS })}
        </p>
      ) : null}
      {loading ? (
        <p
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-accent)]"
        >
          <Spinner />
          {t("messageSearch.searching")}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="px-3 py-2 text-xs text-[var(--color-danger)]">
          {t("messageSearch.failed")}{" "}
          <button type="button" onClick={retry} className="underline">
            {t("tryAgain")}
          </button>
        </p>
      ) : null}
      {ready && !loading && !failed && hits.length === 0 ? (
        <p className="px-3 py-2 text-xs text-[var(--color-muted)]">
          {t("messageSearch.empty", { query: q })}
        </p>
      ) : null}
      {hits.length ? (
        <ul className="flex flex-col">
          {hits.map((hit, i) => (
            <li key={`${hit.session_id}-${i}`}>
              <button
                type="button"
                data-action="open-message-hit"
                onClick={() => {
                  onOpen(hit);
                  onNavigate?.();
                }}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-md)] px-3 py-2 text-left hover:bg-[var(--color-surface-2)]"
              >
                <span className="w-full truncate text-[13px] font-medium leading-[18px] text-[var(--color-fg)]">
                  {hit.title?.trim() || t("messageSearch.untitled")}
                </span>
                <span className="line-clamp-2 w-full break-words text-xs text-[var(--color-muted)]">
                  <Snippet text={hit.snippet} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
