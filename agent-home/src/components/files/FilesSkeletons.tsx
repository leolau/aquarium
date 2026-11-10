import { Bone, bone, skeletonPulse, SkeletonRows } from "@/components/ui/Skeleton";

/**
 * Placeholders for the three Files views. Hook-free, so the route
 * `loading.tsx` files and the client views render the same shapes and the
 * swap to real content doesn't reflow.
 */

const SKELETON_ROWS = ["w-2/5", "w-1/3", "w-3/5", "w-1/2", "w-2/5"];

/**
 * Placeholder rows while a folder list loads (Figma 24:12293 notes: the
 * "Opening…" line over a skeleton). Same shape as the real rows: a table
 * (name · size · modified) from `md`, list rows with a meta line on a phone.
 */
export function BrowseSkeleton() {
  return (
    <div data-component="BrowseSkeleton" aria-hidden="true" className={skeletonPulse}>
      <div className="hidden md:block">
        <div className="grid grid-cols-[minmax(0,1fr)_90px_140px] gap-3 px-3 pb-2">
          <div className={`h-3 w-12 ${bone}`} />
          <div className={`h-3 w-10 ${bone}`} />
          <div className={`h-3 w-16 ${bone}`} />
        </div>
        {SKELETON_ROWS.map((w, i) => (
          <div
            key={i}
            data-skeleton-row
            className="grid grid-cols-[minmax(0,1fr)_90px_140px] items-center gap-3 border-t border-[var(--color-border)] px-3 py-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className={`size-5 shrink-0 ${bone}`} />
              <div className={`h-3 ${w} ${bone}`} />
            </div>
            <div className={`h-3 w-10 ${bone}`} />
            <div className={`h-3 w-16 ${bone}`} />
          </div>
        ))}
      </div>
      <ul className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] md:hidden">
        {SKELETON_ROWS.map((w, i) => (
          <li
            key={i}
            data-skeleton-row
            className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-3 last:border-b-0"
          >
            <div className={`size-5 shrink-0 ${bone}`} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className={`h-3 ${w} ${bone}`} />
              <div className={`h-2.5 w-1/4 ${bone}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Placeholder place cards while the places list loads. */
export function PlacesSkeleton() {
  return (
    <div data-component="PlacesSkeleton" aria-hidden="true" className={skeletonPulse}>
      <div className={`mx-2 mb-2 mt-2 h-2.5 w-16 ${bone}`} />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="mb-2 flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
        >
          <div className={`size-5 shrink-0 ${bone}`} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className={`h-3 w-3/5 ${bone}`} />
            <div className={`h-2.5 w-4/5 ${bone}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Files → Browse before its first paint: places pane + folder card. */
export function FilesBrowseSkeleton() {
  return (
    <div
      data-component="FilesBrowseSkeleton"
      className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]"
    >
      <div className="hidden self-start rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 md:block">
        <PlacesSkeleton />
      </div>
      <div aria-hidden="true" className={`md:hidden ${skeletonPulse}`}>
        <div className="h-11 w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]" />
      </div>
      <div className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 md:p-4">
        <BrowseSkeleton />
      </div>
    </div>
  );
}

/** Files → Arrived: bridge link, search, filter chips, file cards, pager. */
export function FilesArrivedSkeleton() {
  return (
    <div data-component="FilesArrivedSkeleton" aria-hidden="true" className={`flex flex-col gap-4 ${skeletonPulse}`}>
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Bone className="h-3 w-28" />
          <Bone className="h-2.5 w-3/5" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="h-9 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
        <div className="flex flex-wrap gap-2">
          {["w-20", "w-16", "w-24", "w-20"].map((w, i) => (
            <Bone key={i} className={`h-7 ${w} rounded-full`} />
          ))}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {SKELETON_ROWS.map((w, i) => (
          <li
            key={i}
            data-skeleton-row
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <Bone className={`h-3 ${w}`} />
            <Bone className="mt-2 h-2.5 w-3/4" />
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between">
        <Bone className="h-3 w-14" />
        <Bone className="h-6 w-32" />
      </div>
    </div>
  );
}

/** One titled card with list rows, the Folder bridge's section shape. */
function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div aria-hidden="true" className={`flex items-center justify-between gap-2 ${skeletonPulse}`}>
        <Bone className="h-3 w-32" />
        <Bone className="h-7 w-24 rounded-xl" />
      </div>
      <div aria-hidden="true" className={`mt-3 flex flex-col gap-1.5 ${skeletonPulse}`}>
        <Bone className="h-2.5 w-full" />
        <Bone className="h-2.5 w-4/5" />
      </div>
      {rows > 0 ? <SkeletonRows rows={rows} className="mt-3" /> : null}
    </div>
  );
}

/** Files → Folder bridge: connection, folders on this Mac, network folders, search. */
export function FolderBridgeSkeleton() {
  return (
    <div data-component="FolderBridgeSkeleton" className="flex flex-col gap-4">
      <SectionSkeleton rows={0} />
      <SectionSkeleton rows={2} />
      <SectionSkeleton rows={2} />
      <SectionSkeleton rows={0} />
    </div>
  );
}
