"use client";

import { useState, type ReactNode } from "react";

import { memoryTitle } from "@/components/projects/inputs/inputKinds";
import { useMemorySearch } from "@/components/projects/inputs/useMemorySearch";
import type { MemoryRow } from "@/types";

/**
 * Search the caller's memories. Before anything is typed it searches with
 * `suggestFrom` (the goal) and labels those as suggestions. Each result is
 * either a checkbox (`selected` + `onToggle`, the wizard) or whatever
 * `renderAction` draws (an Add button per row, the Inputs tab).
 */
export function MemoryPicker({
  suggestFrom = "",
  selected,
  onToggle,
  renderAction,
  fetchImpl,
  debounceMs,
}: {
  suggestFrom?: string;
  /** Selected rows by id — they stay listed when the search changes. */
  selected?: ReadonlyMap<string, MemoryRow>;
  onToggle?: (row: MemoryRow, checked: boolean) => void;
  renderAction?: (row: MemoryRow) => ReactNode;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const effective = typed || suggestFrom.trim();
  const search = useMemorySearch(effective, { fetchImpl, debounceMs });
  const suggesting = !typed && Boolean(suggestFrom.trim());

  const selectedRows = selected ? Array.from(selected.values()) : [];
  const shown = [
    ...selectedRows,
    ...search.results.filter((row) => !selected?.has(row.id)),
  ];

  const row = (memory: MemoryRow) => {
    const checked = selected?.has(memory.id) ?? false;
    const body = (
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{memoryTitle(memory)}</p>
        {memory.text && memory.text !== memoryTitle(memory) ? (
          <p className="line-clamp-2 text-xs text-[var(--color-muted)]">{memory.text}</p>
        ) : null}
      </div>
    );
    if (onToggle) {
      return (
        <li key={memory.id}>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 ${
              checked
                ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
                : "border-[var(--color-border)]"
            }`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              onChange={(e) => onToggle(memory, e.target.checked)}
              aria-label={memoryTitle(memory)}
            />
            {body}
          </label>
        </li>
      );
    }
    return (
      <li
        key={memory.id}
        className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2"
      >
        {body}
        {renderAction?.(memory)}
      </li>
    );
  };

  return (
    <div data-component="MemoryPicker" className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search memory"
        placeholder="Search memory… e.g. a company, a person, a past agreement"
        className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      {shown.length > 0 ? <ul className="flex flex-col gap-1.5">{shown.map(row)}</ul> : null}
      {search.loading ? (
        <p className="text-xs text-[var(--color-muted)]">Searching…</p>
      ) : search.error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {search.error}
        </p>
      ) : effective && search.answered === effective && search.results.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {suggesting ? "Nothing in your memory matches the goal yet." : "No memories match."}
        </p>
      ) : suggesting && search.results.length > 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          ✨ Suggested from your goal.{onToggle ? " Tick to include." : ""}
        </p>
      ) : null}
    </div>
  );
}
