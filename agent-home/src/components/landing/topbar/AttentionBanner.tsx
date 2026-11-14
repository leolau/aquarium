"use client";

import Link from "next/link";
import { useState } from "react";

import { useNeedsYouText } from "@/lib/landing/needsYouText";
import { useHydrated } from "@/lib/use-hydrated";
import type { NeedsYouEntry } from "@/types/landing";

import { AlertIcon, BellIcon, ChevronDownIcon, XIcon } from "@/components/ui/icons";
import { sortNeedsYou } from "./useNeedsYou";

const DISMISS_KEY = "landing.attention.dismissed";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** The item's primary action, as a link: one-tap writes stay on the Needs-you panel. */
function primaryLink(item: NeedsYouEntry): { label: string; href: string } {
  const action =
    item.actions.find((a) => a.href && a.style === "primary") ?? item.actions.find((a) => a.href);
  return action?.href ? { label: action.label, href: action.href } : { label: "Open", href: item.href };
}

/**
 * Mobile amber attention banner (Figma `attention-banner` 6:116): "N things
 * need you · See all" and the most urgent item with its primary action.
 * Collapsible; it can only be dismissed when nothing is blocking, and a
 * dismissal lasts until a different item becomes the most urgent one.
 */
export function AttentionBanner({
  items,
  count,
  blocking,
  onSeeAll,
  now,
  className = "",
}: {
  items: NeedsYouEntry[];
  count: number | null;
  /** Blocking items open; defaults to counting `items`. */
  blocking?: number;
  onSeeAll?: () => void;
  now?: number;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissedNow, setDismissed] = useState<string | null>(null);
  const hydrated = useHydrated();
  const text = useNeedsYouText();
  const { t } = text;
  const dismissed = dismissedNow ?? (hydrated ? readDismissed() : null);

  const total = count ?? items.length;
  if (!total) return null;
  const top = sortNeedsYou(items)[0] ?? null;
  const blockingOpen = (blocking ?? items.filter((i) => i.severity === "blocking").length) > 0;
  const topKey = top?.id ?? `count:${total}`;
  if (!blockingOpen && dismissed === topKey) return null;

  const dismiss = () => {
    setDismissed(topKey);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, topKey);
    } catch {
      /* private mode: dismissal lasts for this mount only */
    }
  };
  const age =
    top && now !== undefined && top.created_at ? text.age(top.created_at, now) : null;
  const meta = top ? [text.detail(top) ?? top.context.project_slug ?? null, age].filter(Boolean).join(" · ") : "";
  const link = top ? primaryLink(top) : null;

  return (
    <section
      data-component="AttentionBanner"
      data-blocking={blockingOpen || undefined}
      data-collapsed={collapsed || undefined}
      aria-label={t("heading")}
      className={`flex flex-col gap-2 border-b border-[var(--color-warn)] bg-[var(--color-attention-bg)] px-4 py-3 ${className}`}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-warn-text)]">
        <BellIcon size={16} className="text-[var(--color-warn)]" />
        <span className="min-w-0 flex-1 truncate">
          {total === 1 ? t("banner.countOne") : t("banner.count", { n: total })}
        </span>
        {onSeeAll ? (
          <button type="button" data-action="needs-you-see-all" onClick={onSeeAll} className="shrink-0">
            {t("banner.seeAll")}
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("banner.expand") : t("banner.collapse")}
          data-action="attention-collapse"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)]"
        >
          <ChevronDownIcon size={14} className={collapsed ? "" : "rotate-180"} />
        </button>
        {!blockingOpen ? (
          <button
            type="button"
            aria-label={t("banner.dismiss")}
            data-action="attention-dismiss"
            onClick={dismiss}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)]"
          >
            <XIcon size={14} />
          </button>
        ) : null}
      </div>
      {!collapsed && top && link ? (
        <div
          data-component="needs-you-item"
          data-severity={top.severity}
          className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-attention-bg)] p-3"
        >
          <AlertIcon size={18} className="mt-0.5 text-[var(--color-warn)]" />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <p className="w-full text-[13px] font-medium text-[var(--color-fg)] [overflow-wrap:anywhere]">{text.title(top)}</p>
            {meta ? <p className="line-clamp-3 w-full text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">{meta}</p> : null}
            <Link
              href={link.href}
              data-action="attention-primary"
              className="mt-1 inline-flex h-9 items-center rounded-[var(--radius-md)] bg-[var(--color-warn)] px-3 text-[13px] font-medium text-[var(--color-bg)]"
            >
              {text.action(link.label)}
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
