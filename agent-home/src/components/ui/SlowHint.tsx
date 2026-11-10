"use client";

import { useT } from "@/i18n/client";

/** How long a wait lasts before the "still working" line appears. */
export const SLOW_WAIT_MS = 4000;

/**
 * "Still working…" — sits under a loading label and fades in once the wait has
 * lasted a few seconds, so a slow backend doesn't read as a frozen page.
 *
 * Timed in CSS (`.aq-slow-hint`, globals.css), not a timer hook: a route
 * loader on a hard load is streamed HTML that isn't hydrated until the page
 * arrives, and the hint has to appear there too. Mount it only while waiting;
 * the delay restarts on every mount.
 */
export function SlowHint({
  delayMs = SLOW_WAIT_MS,
  text,
  className = "",
}: {
  delayMs?: number;
  text?: string;
  className?: string;
}) {
  const t = useT("common");
  return (
    <p
      data-component="SlowHint"
      aria-live="polite"
      style={{ animationDelay: `${delayMs}ms` }}
      className={`aq-slow-hint text-xs text-[var(--color-muted)] ${className}`}
    >
      {text ?? t("stillWorking")}
    </p>
  );
}
