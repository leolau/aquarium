"use client";

import type { ReactNode } from "react";

import { useT } from "@/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";

export type LeftPanelTab = "chats" | "incomings";

export const LEFT_TAB_KEY = "aquarium.landing.leftTab";

const parseTab = (raw: string): LeftPanelTab => (raw === "incomings" ? "incomings" : "chats");
const serializeTab = (tab: LeftPanelTab) => tab;

/** The landing left panel's selected tab, remembered per browser. */
export function useLeftPanelTab(): [LeftPanelTab, (tab: LeftPanelTab) => void] {
  return usePersistentState<LeftPanelTab>(LEFT_TAB_KEY, "chats", parseTab, serializeTab);
}

/**
 * `Chats | Incomings N` switch at the top of the landing left panel and the
 * phone Chats drawer (plan A.1), styled like the Inbox tabs. The count pill
 * is the flagged arrivals still waiting; it hides at zero or while unknown.
 */
export function LeftPanelTabs({
  value,
  onChange,
  incomingsCount,
  urgent = 0,
  idPrefix = "landing-left",
}: {
  value: LeftPanelTab;
  onChange: (tab: LeftPanelTab) => void;
  incomingsCount: number | null;
  /** Some of them are urgent: the pill turns to the danger tone. */
  urgent?: number;
  idPrefix?: string;
}) {
  const t = useT("incomings");
  const tl = useT("landing");
  const count = incomingsCount ?? 0;
  const tabs: [LeftPanelTab, string][] = [
    ["chats", t("tabs.chats")],
    ["incomings", t("tabs.incomings")],
  ];
  return (
    <div
      role="tablist"
      aria-label={tl("panels.sidebarTabs")}
      data-component="LeftPanelTabs"
      className="flex shrink-0 gap-0.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = value === "chats" ? "incomings" : "chats";
        onChange(next);
        document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
      }}
    >
      {tabs.map(([key, label]) => {
        const selected = value === key;
        return (
          <button
            key={key}
            id={`${idPrefix}-tab-${key}`}
            type="button"
            role="tab"
            data-tab={key}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(key)}
            className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-2 text-[13px] lg:min-h-8 ${
              selected
                ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            <span className="truncate">{label}</span>
            {key === "incomings" && count > 0 ? (
              <span
                data-slot="incomings-count"
                aria-label={t("tabs.countLabel", { count })}
                className={`rounded-full px-1.5 text-[10px] font-bold leading-4 tabular-nums ${
                  urgent > 0
                    ? "bg-[var(--color-danger)] text-white"
                    : "bg-[var(--color-warn)] text-[var(--color-bg)]"
                }`}
              >
                {count >= 99 ? "99+" : count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** What the sidebar and the phone drawer need to show the Incomings tab. */
export interface LeftTabsSlot {
  tab: LeftPanelTab;
  onTabChange: (tab: LeftPanelTab) => void;
  count: number | null;
  urgent?: number;
  /** The Incomings panel; the drawer passes a close callback so rows can dismiss it. */
  renderIncomings: (opts: { onNavigate?: () => void; inDrawer: boolean }) => ReactNode;
}
