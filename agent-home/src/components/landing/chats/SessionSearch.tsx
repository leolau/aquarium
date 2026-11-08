"use client";

import { useEffect, useRef } from "react";

import { SearchIcon, XIcon } from "@/components/ui/icons";

/**
 * Filters the sidebar's chats by title, preview or tag. ⌘K / Ctrl+K focuses
 * it when `shortcut` is on (desktop sidebar only, so two lists never fight).
 */
export function SessionSearch({
  value,
  onChange,
  shortcut = false,
  id = "landing-chat-search",
}: {
  value: string;
  onChange: (value: string) => void;
  shortcut?: boolean;
  id?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

  useEffect(() => {
    if (!shortcut) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  return (
    <div
      data-component="SessionSearch"
      className="flex min-h-11 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 focus-within:border-[var(--color-accent)] lg:!min-h-0"
    >
      <SearchIcon size={14} className="shrink-0 text-[var(--color-muted)]" />
      <label htmlFor={id} className="sr-only">
        Search chats
      </label>
      <input
        ref={input}
        id={id}
        type="search"
        value={value}
        placeholder="Search chats"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        className="!min-h-0 min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="grid size-4 !min-h-0 shrink-0 place-items-center text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <XIcon size={12} />
        </button>
      ) : shortcut ? (
        <kbd className="shrink-0 font-sans text-xs font-medium text-[var(--color-muted)]">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      ) : null}
    </div>
  );
}
