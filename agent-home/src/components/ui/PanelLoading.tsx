"use client";

import { SkeletonRows } from "@/components/ui/Skeleton";
import { SlowHint } from "@/components/ui/SlowHint";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/client";

/**
 * In-panel loading state for a list a client component fetches after mount:
 * a small spinner line, placeholder rows, and "still working…" if it drags on.
 * Shown instead of an empty list, which would read as "nothing here".
 */
export function PanelLoading({
  label,
  rows = 2,
  className = "",
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  const t = useT("common");
  return (
    <div data-component="PanelLoading" aria-busy="true" className={`flex flex-col gap-2 ${className}`}>
      <p
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]"
      >
        <Spinner />
        {label ?? t("loading")}
      </p>
      <SkeletonRows rows={rows} />
      <SlowHint />
    </div>
  );
}
