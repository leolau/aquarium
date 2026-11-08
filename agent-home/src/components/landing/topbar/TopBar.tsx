"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { AquariumMark } from "@/components/brand/AquariumMark";
import { buildInfo, useStatusSummary, type StatusSummaryState } from "@/components/ui/useStatusSummary";
import { useActivityRunning, type ActivityRunningState } from "@/components/ui/useActivityRunning";
import type { NeedsYouEntry } from "@/types/landing";

import { AccountMenu } from "./AccountMenu";
import { AttentionBanner } from "./AttentionBanner";
import { HealthPill } from "./HealthPill";
import { PanelLeftIcon } from "@/components/ui/icons";
import { MobileActivityStrip } from "./MobileActivityStrip";
import { NeedsYouBadge } from "./NeedsYouBadge";
import { useNeedsYou } from "./useNeedsYou";

export interface TopBarProps {
  /** Scroll to / open the Needs-you panel (desktop) or list (mobile). */
  onOpenNeedsYou?: () => void;
  /** Shows the panel-left toggle (mobile Chats drawer / desktop sidebar). */
  onToggleSidebar?: () => void;
  /** Account control; defaults to the avatar menu with sign-out. */
  account?: ReactNode;
  accountName?: string | null;
}

export interface TopBarData {
  status: StatusSummaryState;
  activity: ActivityRunningState;
  needsYou: {
    count: number | null;
    blocking: number;
    items: NeedsYouEntry[];
    stale: boolean;
  };
}

/**
 * Presentational top bar (Figma `top-bar` 5:3 desktop, 6:91 + activity strip
 * 6:107 + attention banner 6:116 on mobile). Data comes from `TopBar`.
 */
export function TopBarView({
  status,
  activity,
  needsYou,
  onOpenNeedsYou,
  onToggleSidebar,
  account,
  accountName,
}: TopBarProps & TopBarData) {
  const build = buildInfo(status.summary);
  return (
    <div data-component="TopBar" data-build-mismatch={build.buildMismatch || undefined}>
      <header className="flex h-14 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 lg:gap-4">
        <div data-component="brand" className="flex shrink-0 items-center gap-2">
          {onToggleSidebar ? (
            <button
              type="button"
              aria-label="Toggle chats"
              data-action="toggle-sidebar"
              onClick={onToggleSidebar}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]"
            >
              <PanelLeftIcon size={18} />
            </button>
          ) : null}
          <Link href="/" aria-label="Aquarium home" data-action="home" className="flex items-center gap-2 rounded-[var(--radius-md)]">
            <AquariumMark size={24} title="" />
            <span className="text-sm font-semibold text-[var(--color-fg)]">Aquarium</span>
          </Link>
        </div>
        <div className="hidden min-w-0 lg:flex">
          <HealthPill variant="bar" status={status} activity={activity} />
        </div>
        <div aria-hidden className="flex-1" />
        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          <HealthPill variant="compact" status={status} activity={activity} />
          <NeedsYouBadge compact count={needsYou.count} stale={needsYou.stale} onOpen={onOpenNeedsYou} />
        </div>
        <div className="hidden lg:flex">
          <NeedsYouBadge count={needsYou.count} stale={needsYou.stale} onOpen={onOpenNeedsYou} />
        </div>
        {account ?? <AccountMenu name={accountName} />}
      </header>
      <MobileActivityStrip
        items={activity.items}
        now={activity.now}
        stale={activity.stale}
        className="lg:hidden"
      />
      <AttentionBanner
        items={needsYou.items}
        count={needsYou.count}
        blocking={needsYou.blocking}
        onSeeAll={onOpenNeedsYou}
        now={activity.now}
        className="lg:hidden"
      />
    </div>
  );
}

/**
 * The landing top bar: Aquarium mark, health pill (every StatusStrip
 * reading), Needs-you badge, account menu; on mobile also the one-line
 * activity strip and the amber attention banner. Reuses the StatusStrip /
 * ActivityStrip data hooks, so their caches are shared across pages.
 */
export function TopBar(props: TopBarProps) {
  const status = useStatusSummary();
  const activity = useActivityRunning();
  const needsYou = useNeedsYou();
  return <TopBarView {...props} status={status} activity={activity} needsYou={needsYou} />;
}
