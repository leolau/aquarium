"use client";

import type { ProjectViewMode } from "@/types";

const OPTIONS: readonly { mode: ProjectViewMode; label: string }[] = [
  { mode: "task", label: "Task mode" },
  { mode: "project", label: "Project mode" },
];

/** The segmented "Task mode | Project mode" control. */
export function ModeSwitch({
  mode,
  onChange,
  taskDisabledReason,
}: {
  mode: ProjectViewMode;
  onChange: (mode: ProjectViewMode) => void;
  /** Set when this project can't be shown as a task (repeating / standing). */
  taskDisabledReason?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      data-component="ModeSwitch"
      className="inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs"
    >
      {OPTIONS.map((option) => {
        const on = option.mode === mode;
        const disabled = option.mode === "task" && !!taskDisabledReason;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={disabled ? taskDisabledReason : undefined}
            onClick={() => {
              if (!on) onChange(option.mode);
            }}
            className={`rounded-full px-3 py-1 font-medium ${
              on ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-muted)]"
            } disabled:opacity-40`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
