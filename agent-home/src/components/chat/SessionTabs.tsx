"use client";

import { useMemo, useState } from "react";

import {
  categorizeSession,
  CHAT_CATEGORY_LABELS,
  CHAT_CATEGORY_ORDER,
  groupSessionsByCategory,
  type ChatCategory,
} from "@/lib/chat/categorize";
import type { SessionSummary } from "@/types";

const NEW_KEY = "__new__";

function titleOf(s: SessionSummary): string {
  return s.title || s.preview || "Untitled";
}

/**
 * The principal's conversations at the top of the chat page: a "Category"
 * dropdown (Kanban / Daily / Scheduled / Others — see `lib/chat/categorize.ts`)
 * plus a single horizontally-scrollable row of chips for whichever category
 * is selected. Tapping a non-active chip switches to that conversation;
 * tapping the *active* chip opens its details popup (rename + stats). A
 * pulsing dot marks a conversation with a live turn.
 *
 * This used to render every category as its own stacked row simultaneously
 * (and, before that, a single flat row with no grouping at all, and briefly
 * a separate "All conversations" modal). Both predecessors are gone: the
 * stacked-rows version wasted vertical space showing every category at
 * once even though only one is usually relevant; the dropdown shows
 * exactly one row's worth of chips, so fetching every session (see
 * `HermesApiClient.allSessions`) doesn't mean a taller page — it's fine for
 * the selected category's row to be long, since it's the only row.
 *
 * Categories with zero conversations aren't offered in the dropdown at
 * all — nothing to switch to.
 *
 * Drag-to-reorder is scoped to *within* the selected category's row:
 * dragging changes that category's relative order among itself, then the
 * new global id order is rebuilt by splicing the reordered ids back into
 * their original slots (every other category's ids keep their exact
 * positions).
 */
export function SessionTabs({
  sessions,
  activeId,
  busyKeys,
  onSelect,
  onOpenDetails,
  onNew,
  onReorder,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  busyKeys: string[];
  onSelect: (id: string) => void;
  onOpenDetails: (session: SessionSummary) => void;
  /** Switch back to the not-yet-persisted "New conversation" (used by the busy chip). */
  onNew: () => void;
  /** Commit a new left-to-right ordering of the session ids (drag-to-reorder). */
  onReorder: (orderedIds: string[]) => void;
}) {
  // A brand-new conversation has no persisted row yet (it only gets one when
  // its first turn completes). Show it as a chip whenever it is on screen OR
  // has a live turn running — otherwise switching away mid-turn would make the
  // new conversation vanish from the strip until the turn finishes.
  const newActive = activeId === null;
  const newBusy = busyKeys.includes(NEW_KEY);
  const showNew = newActive || newBusy;

  // Categorized once per render of the same session list, so a drag
  // interaction and its resulting reorder-rebuild agree on categories even
  // right at a local-day boundary.
  const now = useMemo(
    () => new Date(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions],
  );
  const groups = useMemo(() => groupSessionsByCategory(sessions, now), [sessions, now]);
  const availableCategories = useMemo(
    () => CHAT_CATEGORY_ORDER.filter((c) => groups[c].length > 0),
    [groups],
  );

  const [selectedCategory, setSelectedCategory] = useState<ChatCategory>(() => {
    const activeSession = sessions.find((s) => s.id === activeId);
    if (activeSession) return categorizeSession(activeSession, now);
    return availableCategories[0] ?? "others";
  });

  // Jump the dropdown to match wherever the active conversation actually is
  // (e.g. opened via a memory citation) — but only in reaction to the active
  // conversation changing, so a manual dropdown switch is never fought on
  // the next unrelated re-render.
  // A brand-new conversation becomes active before the session list
  // refetch includes it, so the jump waits until it actually appears.
  const [syncedActiveId, setSyncedActiveId] = useState<string | null>(() =>
    sessions.some((s) => s.id === activeId) ? activeId : null,
  );
  if (activeId !== syncedActiveId) {
    const activeSession = sessions.find((s) => s.id === activeId);
    if (activeSession) {
      setSyncedActiveId(activeId);
      setSelectedCategory(categorizeSession(activeSession, now));
    }
  }

  // If the selected category emptied out (its last conversation was
  // archived, etc.), fall back to whatever is actually available instead of
  // showing a dropdown value with no matching option.
  const effectiveCategory = availableCategories.includes(selectedCategory)
    ? selectedCategory
    : availableCategories[0] ?? selectedCategory;

  const items = groups[effectiveCategory] ?? [];

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function dropWithinCategory(from: number, to: number) {
    setDragIndex(null);
    setOverIndex(null);
    if (from === to) return;
    const catIds = items.map((s) => s.id);
    const [moved] = catIds.splice(from, 1);
    catIds.splice(to, 0, moved);
    // Rebuild the full id order: walk the original order, replacing this
    // category's ids with their new local order and leaving every other
    // id exactly where it was.
    let catPos = 0;
    const newOrder = sessions.map((s) => {
      if (categorizeSession(s, now) !== effectiveCategory) return s.id;
      const id = catIds[catPos];
      catPos += 1;
      return id;
    });
    onReorder(newOrder);
  }

  return (
    <div data-component="SessionTabs" className="mb-3">
      {showNew ? (
        <div className="mb-2 flex gap-2">
          {newActive ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium text-[var(--color-fg)]">
              New conversation
              {newBusy ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
              ) : null}
            </span>
          ) : (
            <button
              type="button"
              onClick={onNew}
              aria-label="Switch to the new conversation"
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-muted)]"
            >
              New conversation
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
            </button>
          )}
        </div>
      ) : null}

      {availableCategories.length > 0 ? (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <label htmlFor="chat-category" className="shrink-0 text-[var(--color-muted)]">
            Category
          </label>
          <select
            id="chat-category"
            value={effectiveCategory}
            onChange={(e) => setSelectedCategory(e.target.value as ChatCategory)}
            className="min-w-0 flex-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-fg)]"
          >
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {CHAT_CATEGORY_LABELS[c]} ({groups[c].length})
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
        {items.map((s, index) => {
          const active = s.id === activeId;
          const busy = busyKeys.includes(s.id);
          const dragging = dragIndex === index;
          const dropTarget = overIndex === index && dragIndex !== index;
          return (
            <button
              key={s.id}
              type="button"
              draggable
              onClick={() => (active ? onOpenDetails(s) : onSelect(s.id))}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIndex !== index) setOverIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) dropWithinCategory(dragIndex, index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              aria-label={
                active
                  ? `Edit conversation "${titleOf(s)}"`
                  : `Switch to conversation "${titleOf(s)}"`
              }
              title="Drag to reorder within this category"
              className={`flex shrink-0 cursor-grab items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium active:cursor-grabbing ${
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
              } ${dragging ? "opacity-40" : ""} ${
                dropTarget ? "ring-2 ring-[var(--color-accent)]" : ""
              }`}
            >
              <span className="max-w-[9rem] truncate">{titleOf(s)}</span>
              {busy ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
              ) : null}
              {active ? (
                <span aria-hidden="true" className="text-xs opacity-70">
                  ✎
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
