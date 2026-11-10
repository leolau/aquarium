"use client";

import { useEffect, useState, type ReactNode } from "react";

import { SlowHint } from "@/components/ui/SlowHint";
import { Spinner } from "@/components/ui/Spinner";

/**
 * How long a wait has to last before the overlay becomes *visible*. Fast
 * round-trips shouldn't flash a spinner — that reads as jank, not as feedback.
 * The blocking layer itself is mounted immediately regardless (see below), so
 * the delay only affects what the user sees, never whether stray taps land.
 */
export const BUSY_VISIBLE_DELAY_MS = 150;

/**
 * Wraps a region of the page that waits on the backend.
 *
 * While `busy`, an overlay is mounted over the region. It does two jobs the app
 * was missing everywhere outside Chat:
 *
 * 1. **Says something is happening** — a spinner plus a human label, in an
 *    `aria-live` region so it is announced as well as drawn. On a box with a
 *    lot of records a request can take seconds, and until now the UI simply sat
 *    there looking dead.
 * 2. **Absorbs input** — the overlay covers the region's own controls, so a
 *    second tap on the button you just pressed (or on a neighbouring one)
 *    cannot fire a second request against a half-applied state.
 *
 * It deliberately covers only its region, not the whole viewport: the nav stays
 * reachable, so a slow request can never trap the user on a page.
 *
 * Adoption is one wrapper per view — the views already track a busy boolean,
 * they just never showed it.
 */
export function BusyRegion({
  busy,
  label = "Working…",
  children,
  className = "",
}: {
  busy: boolean;
  /** Human-readable description of what is being waited on. */
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  // Mounted-but-invisible until the wait proves slow enough to be worth
  // showing. `busy` alone still gates the blocking layer.
  const [shown, setShown] = useState(false);
  // Going idle resets during render, not in an effect: the overlay is gone in
  // the same commit that clears `busy`, with no frame of stale spinner.
  if (!busy && shown) setShown(false);

  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setShown(true), BUSY_VISIBLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  return (
    <div
      data-component="BusyRegion"
      data-busy={busy ? "true" : "false"}
      aria-busy={busy}
      className={`relative ${className}`}
    >
      {children}
      {busy ? (
        <div
          // `inset-0` over a `relative` parent, above the region's controls but
          // below the fixed nav (z-30) and modals (z-50) so neither is trapped.
          className={`absolute inset-0 z-10 flex items-start justify-center rounded-2xl transition-opacity duration-150 ${
            shown ? "bg-[var(--color-bg)]/60 opacity-100" : "opacity-0"
          }`}
        >
          <div className="sticky top-6 mt-6 flex max-w-[calc(100%-2rem)] flex-col items-center gap-1.5">
            <p
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium text-[var(--color-accent)] shadow-lg"
            >
              <Spinner />
              {label}
            </p>
            <SlowHint className="rounded-xl bg-[var(--color-surface)] px-2 py-1 text-center shadow" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
