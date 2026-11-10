"use client";

import type { ReactNode } from "react";

import { skeletonPulse } from "@/components/ui/Skeleton";
import { SlowHint } from "@/components/ui/SlowHint";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/client";

/**
 * The placeholder every route's `loading.tsx` renders.
 *
 * Every page in agent-home is a `force-dynamic` server component that awaits
 * several upstream calls before it can render anything, so without a route-level
 * loading UI a tap on the nav left the *previous* page on screen, frozen, until
 * the server replied — the app read as slow and unresponsive even when it was
 * merely working. Paired with a `loading.tsx` per segment, the shell and this
 * skeleton paint immediately instead, and a "still working…" line follows if
 * the wait runs past a few seconds.
 *
 * `rows` should roughly match the shape of the real page so the swap isn't a
 * jarring reflow; pass `children` instead for a page-specific skeleton.
 */
export function PageSkeleton({
  rows = 4,
  label,
  children,
}: {
  rows?: number;
  label?: string;
  children?: ReactNode;
}) {
  const t = useT("common");
  return (
    <div data-component="PageSkeleton" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1.5 self-start">
        <p
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 self-start rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium text-[var(--color-accent)]"
        >
          <Spinner />
          {label ?? t("loading")}
        </p>
        <SlowHint className="px-1" />
      </div>
      {children ?? (
        <div aria-hidden="true" className={`flex flex-col gap-3 ${skeletonPulse}`}>
          {Array.from({ length: rows }, (_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="h-3 w-1/3 rounded bg-[var(--color-surface-2)]" />
              <div className="mt-3 h-3 w-full rounded bg-[var(--color-surface-2)]" />
              <div className="mt-2 h-3 w-4/5 rounded bg-[var(--color-surface-2)]" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
