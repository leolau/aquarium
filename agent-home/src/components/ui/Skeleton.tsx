/**
 * Skeleton building blocks shared by every loading state.
 *
 * Hook-free so route `loading.tsx` files (server components) and client
 * panels can both use them. The pulse stops under `prefers-reduced-motion`;
 * the grey shapes alone still say "content goes here".
 */
export const skeletonPulse = "animate-pulse motion-reduce:animate-none";

/** One placeholder shape. */
export const bone = "rounded-[var(--radius-sm)] bg-[var(--color-surface-2)]";

export function Bone({ className = "" }: { className?: string }) {
  return <div className={`${bone} ${className}`} />;
}

/**
 * Placeholder rows for a list inside an existing card: an icon square and two
 * text lines per row, matching the app's compact list rows.
 */
export function SkeletonRows({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div data-component="SkeletonRows" aria-hidden="true" className={`flex flex-col gap-1.5 ${skeletonPulse} ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          data-skeleton-row
          className="flex items-center gap-3 rounded-lg bg-[var(--color-surface-2)]/50 px-3 py-2.5"
        >
          <Bone className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bone className={`h-3 ${i % 2 ? "w-1/3" : "w-1/2"}`} />
            <Bone className="h-2.5 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
