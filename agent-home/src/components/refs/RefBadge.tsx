"use client";

import { useEffect, useState } from "react";

/**
 * A short ref (`P12`, `T345`, `P12-R3`) as a small mono chip; a tap copies
 * it so it can be pasted into a prompt. Renders nothing without a ref (an
 * older backend). The copy pattern is `skills/CopyButton`'s.
 */
export function RefBadge({ value, className = "" }: { value?: string | null; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (!value) return null;
  return (
    <button
      type="button"
      data-component="RefBadge"
      data-ref={value}
      title={`Copy ${value}`}
      aria-label={copied ? `Copied ${value}` : `Copy reference ${value}`}
      onClick={(event) => {
        // A badge sits inside links and draggable cards: copy, don't navigate.
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      className={`inline-flex shrink-0 items-center rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] leading-4 text-[var(--color-muted)] hover:text-[var(--color-fg)] ${className}`}
    >
      {copied ? "Copied" : value}
    </button>
  );
}
