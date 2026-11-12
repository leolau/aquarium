"use client";

import type { ReactNode } from "react";

/** Per-browser memory of whether the chat's filters & search panel is open. */
export const CHAT_FILTERS_OPEN_STORAGE_KEY = "agent-home:chat-filters-open";
export const parseFiltersOpen = (raw: string): boolean => raw === "1";
export const serializeFiltersOpen = (open: boolean): string => (open ? "1" : "0");

const PANEL_ID = "chat-filters-panel";

/**
 * The chat's profile picker, tag filters and searches, folded behind one
 * "Filters & search" toggle so the transcript gets the screen. Collapsed it is
 * a single slim row: the toggle, the current profile, and a badge counting the
 * active filters (a collapsed panel must never hide that filters apply).
 *
 * The panel body stays mounted while collapsed (`hidden`, not unmounted) so
 * collapsing never clears a typed search, its results or the highlights.
 */
export function ChatFiltersPanel({
  open,
  onToggle,
  profile,
  filterCount,
  searchActive,
  compactOnPhone = false,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  profile: string;
  /** Tag filters (include + exclude) currently narrowing the session list. */
  filterCount: number;
  /** A search bar is open or its highlights are showing. */
  searchActive: boolean;
  /**
   * Phones: drop the collapsed row while nothing applies — the title bar's
   * menu opens the panel. It stays whenever a filter or search is on.
   */
  compactOnPhone?: boolean;
  children: ReactNode;
}) {
  const rowHidden = compactOnPhone && !open && filterCount === 0 && !searchActive;
  return (
    <div data-component="ChatFiltersPanel" className={rowHidden ? "mb-2 max-lg:mb-0" : "mb-2"}>
      <div className={`flex min-w-0 items-center gap-2 text-xs${rowHidden ? " max-lg:hidden" : ""}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={PANEL_ID}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-fg)]"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          Filters &amp; search
        </button>
        <span
          data-testid="chat-filters-profile"
          className="min-w-0 truncate text-[var(--color-muted)]"
          title={`Profile: ${profile}`}
        >
          <span className="sr-only">Profile: </span>
          {profile}
        </span>
        {filterCount > 0 ? (
          <span
            data-testid="chat-filters-badge"
            className="shrink-0 rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[0.625rem] font-semibold text-[var(--color-accent-fg)]"
          >
            {filterCount} {filterCount === 1 ? "filter" : "filters"}
          </span>
        ) : null}
        {searchActive && !open ? (
          <span
            data-testid="chat-filters-search"
            className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[0.625rem] text-[var(--color-muted)]"
          >
            Search on
          </span>
        ) : null}
      </div>
      <div
        id={PANEL_ID}
        role="region"
        aria-label="Filters and search"
        hidden={!open}
        className="mt-2 max-h-[40dvh] overflow-y-auto"
      >
        {children}
      </div>
    </div>
  );
}
