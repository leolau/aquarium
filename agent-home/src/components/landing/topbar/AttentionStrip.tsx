"use client";

import { BellIcon, ChevronRightIcon } from "@/components/ui/icons";
import type { NeedsYouEntry } from "@/types/landing";

/**
 * One 44px line for blocking Needs-you items on the phone chat page, in place
 * of the full {@link AttentionBanner} card: "1 blocking · <title> ›". Opens
 * the Needs-you list. Non-blocking items live only in the bell badge, so this
 * renders nothing without a blocking item.
 */
export function AttentionStrip({
  items,
  blocking,
  onOpen,
  className = "",
}: {
  items: NeedsYouEntry[];
  /** Server count of open blocking items (may exceed the loaded `items`). */
  blocking?: number;
  onOpen?: () => void;
  className?: string;
}) {
  const blockingItems = items.filter((i) => i.severity === "blocking");
  const count = Math.max(blocking ?? 0, blockingItems.length);
  if (count === 0) return null;
  const top = blockingItems[0];
  return (
    <button
      type="button"
      data-component="AttentionStrip"
      data-action="needs-you-blocking"
      onClick={onOpen}
      aria-label={`${count} blocking ${count === 1 ? "item needs" : "items need"} you — open the list`}
      className={`flex h-11 w-full min-w-0 items-center gap-2 border-b border-[var(--color-warn)] bg-[var(--color-attention-bg)] px-4 text-left text-[13px] text-[var(--color-warn-text)] ${className}`}
    >
      <BellIcon size={16} className="text-[var(--color-warn)]" />
      <span className="shrink-0 font-semibold">{count} blocking</span>
      {top ? <span className="min-w-0 flex-1 truncate">· {top.title}</span> : <span className="flex-1" />}
      <ChevronRightIcon size={16} />
    </button>
  );
}
