"use client";

import type { NeedsYouEntry } from "@/types/landing";

import { NeedsYouItem } from "./NeedsYouItem";
import { SectionHeader } from "./SectionHeader";
import { SEVERITY_RANK } from "./tone";
import { useNow } from "./usePolled";
import { type NeedsYouFeed, useNeedsYouFeed } from "./useNeedsYouFeed";

const AGE_TICK_MS = 30_000;

/** Most urgent first; the server's order is kept within a severity. */
export function sortBySeverity(items: NeedsYouEntry[]): NeedsYouEntry[] {
  return items
    .map((entry, i) => ({ entry, i }))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.entry.severity] ?? 9) - (SEVERITY_RANK[b.entry.severity] ?? 9) ||
        a.i - b.i,
    )
    .map((x) => x.entry);
}

export type NeedsYouPanelViewProps = Pick<
  NeedsYouFeed,
  "items" | "count" | "newIds" | "loaded" | "stale"
> & { onActed?: (entry: NeedsYouEntry) => void };

/**
 * "Needs you" (Figma `work-panel` top half, `5:2`; all-clear `10:237`):
 * one row per waiting item, most urgent first, or the all-clear picture.
 */
export function NeedsYouPanelView({
  items,
  count,
  newIds,
  loaded,
  stale,
  onActed,
}: NeedsYouPanelViewProps) {
  const now = useNow(true, AGE_TICK_MS);
  const sorted = sortBySeverity(items);
  const shownCount = loaded ? Math.max(count, items.length) : null;

  return (
    <section
      data-component="NeedsYouPanel"
      data-stale={stale || undefined}
      aria-labelledby="needs-you-heading"
      className={`flex flex-col gap-2 ${stale ? "opacity-60" : ""}`}
    >
      <SectionHeader
        id="needs-you-heading"
        label="Needs you"
        count={shownCount}
        attention={sorted.length > 0}
      />
      {!loaded ? (
        stale ? (
          <p className="px-3 text-[12px] leading-[16px] text-[var(--color-muted)]">
            Couldn’t check right now — retrying.
          </p>
        ) : (
          <div aria-hidden className="flex flex-col gap-2" data-testid="needs-you-skeleton">
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
            <div className="h-[102px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
          </div>
        )
      ) : sorted.length === 0 ? (
        <div
          data-testid="needs-you-all-clear"
          className="flex flex-col items-center gap-2 py-3 text-center"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/illustrations/needs-you-all-clear@2x.png"
            alt=""
            width={160}
            height={125}
            className="h-[125px] w-[160px] object-contain"
          />
          <p className="text-[13px] font-medium leading-[18px] text-[var(--color-fg)]">
            Nothing needs you right now
          </p>
          <p className="text-[12px] font-medium leading-[16px] text-[var(--color-muted)]">
            We’ll flag it here, in the top bar and by push.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Waiting on you">
          {sorted.map((entry) => (
            <NeedsYouItem
              key={entry.id}
              entry={entry}
              now={now}
              isNew={newIds.has(entry.id)}
              onActed={onActed}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Self-fetching Needs-you panel. Pass `feed` to share one poll with the page. */
export function NeedsYouPanel({ feed }: { feed?: NeedsYouFeed }) {
  return feed ? <NeedsYouPanelView {...feed} onActed={() => void feed.refresh()} /> : <OwnFeed />;
}

function OwnFeed() {
  const feed = useNeedsYouFeed();
  return <NeedsYouPanelView {...feed} onActed={() => void feed.refresh()} />;
}
