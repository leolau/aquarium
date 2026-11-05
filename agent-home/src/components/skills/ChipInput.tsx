"use client";

import { useId, useState } from "react";

/** A list of values as removable chips plus a text box to add more (Enter or comma). */
export function ChipInput({
  label,
  values,
  onChange,
  placeholder,
  suggestions,
  disabled,
}: {
  label: string;
  values: string[];
  onChange(next: string[]): void;
  placeholder?: string;
  suggestions?: string[];
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  function add(raw: string) {
    const v = raw.trim();
    setDraft("");
    if (v && !values.includes(v)) onChange([...values, v]);
  }
  return (
    <div
      data-component="ChipInput"
      className={`flex flex-wrap items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 ${
        disabled ? "opacity-60" : "focus-within:border-[var(--color-accent)]"
      }`}
    >
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] pl-2.5 text-xs">
          {v}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="!min-h-0 rounded-full px-1.5 py-0.5 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            ✕
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        disabled={disabled}
        list={suggestions?.length ? listId : undefined}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) add(v.slice(0, -1));
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        className="!min-h-9 min-w-[6rem] flex-1 bg-transparent px-1 text-sm outline-none"
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !values.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      ) : null}
    </div>
  );
}
