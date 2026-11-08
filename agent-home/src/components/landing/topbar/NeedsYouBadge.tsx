"use client";

import { BellIcon, CheckIcon } from "./icons";

/**
 * Figma `needs-you-badge` (4:84). Amber with the count when something needs
 * the user, green "All clear" at zero, muted while the count is unknown.
 * `compact` (mobile) shows only the number.
 */
export function NeedsYouBadge({
  count,
  stale = false,
  compact = false,
  onOpen,
  className = "",
}: {
  count: number | null;
  stale?: boolean;
  compact?: boolean;
  onOpen?: () => void;
  className?: string;
}) {
  const state = count === null ? "unknown" : count > 0 ? "some" : "none";
  const label =
    state === "some"
      ? compact
        ? String(count)
        : `${count} need${count === 1 ? "s" : ""} you`
      : state === "none"
        ? "All clear"
        : "Needs you";
  const aria =
    state === "some"
      ? `${count} ${count === 1 ? "item needs" : "items need"} you — open the list`
      : state === "none"
        ? "All clear — nothing needs you"
        : "Needs you — not loaded yet";
  const tone =
    state === "some"
      ? "bg-[var(--color-warn)] text-[var(--color-bg)]"
      : state === "none"
        ? "bg-[var(--color-surface-2)] text-[var(--color-success)]"
        : "bg-[var(--color-surface-2)] text-[var(--color-muted)]";
  return (
    <button
      type="button"
      data-component="NeedsYouBadge"
      data-state={state}
      data-stale={stale || undefined}
      aria-label={aria}
      title={stale ? `${aria} (couldn't refresh — showing the last count)` : aria}
      onClick={onOpen}
      className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-[13px] font-medium transition-opacity hover:opacity-90 ${tone} ${
        stale ? "opacity-70" : ""
      } ${className}`}
    >
      {state === "none" ? <CheckIcon size={16} /> : <BellIcon size={16} />}
      {compact && state !== "some" ? <span className="sr-only">{label}</span> : <span>{label}</span>}
    </button>
  );
}
