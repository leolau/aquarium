"use client";

import { Spinner } from "@/components/ui/Spinner";
import type { ProfileSummary } from "@/types";

/** The profile the picker means when nothing is selected. */
export const DEFAULT_PROFILE = "default";

/**
 * Chooses a profile (FG-28). A profile is an independent `HERMES_HOME` — its
 * own SOUL, goal, skills, memory, credentials and conversations — so this
 * switches *which brain* replies, and with it everything shown, not merely a
 * filter over one list. The header's `ProfileSwitcher` wires it to the session.
 *
 * Renders nothing with fewer than two profiles: the overwhelmingly common
 * deployment should not carry a control with one option.
 */
export function ProfilePicker({
  profiles,
  selected,
  onSelect,
  disabled = false,
  switching = false,
  compact = false,
  id = "session-profile",
  label = "Profile",
}: {
  profiles: ProfileSummary[];
  selected: string;
  onSelect: (profile: string) => void;
  /** True while a turn is in flight — switching mid-turn is refused. */
  disabled?: boolean;
  /** True while the chosen profile's conversations are still loading. */
  switching?: boolean;
  /** Header placement: no bottom margin, no description. */
  compact?: boolean;
  /** The select's id — distinct when two pickers share a page. */
  id?: string;
  label?: string;
}) {
  if (profiles.length < 2) return null;

  const active = profiles.find((p) => p.name === selected);

  return (
    <div
      data-component="ProfilePicker"
      className={`${compact ? "" : "mb-3 "}flex items-center gap-2 text-xs`}
    >
      <label
        htmlFor={id}
        className="shrink-0 text-[var(--color-muted)]"
      >
        {label}
      </label>
      <select
        id={id}
        value={selected}
        disabled={disabled || switching}
        onChange={(e) => onSelect(e.target.value)}
        className="min-w-0 flex-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-fg)] disabled:opacity-50"
      >
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.is_default ? " (default)" : ""}
          </option>
        ))}
      </select>
      {/* Switching swaps a whole HERMES_HOME, so the reload takes long enough to
       * look like the tap missed. The select is held until it lands. */}
      {switching ? (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex shrink-0 items-center gap-1 text-[var(--color-accent)]"
        >
          <Spinner />
          Loading…
        </span>
      ) : !compact && active?.description ? (
        <span className="hidden truncate text-[var(--color-muted)] sm:block">
          {active.description}
        </span>
      ) : null}
    </div>
  );
}
