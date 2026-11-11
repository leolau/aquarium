"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { AquariumMark } from "@/components/brand/AquariumMark";
import { buildInfo, useStatusSummary, type StatusSummaryState } from "@/components/ui/useStatusSummary";
import { useActivityRunning, type ActivityRunningState } from "@/components/ui/useActivityRunning";
import type { ProfileRole } from "@/lib/api/my-profiles";
import type { Role } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

import { AccountMenu } from "./AccountMenu";
import { AttentionBanner } from "./AttentionBanner";
import { HealthPill } from "./HealthPill";
import { MobileActivityStrip } from "./MobileActivityStrip";
import { RunningStripView } from "./RunningStrip";
import { NeedsYouBadge } from "./NeedsYouBadge";
import { useNeedsYou } from "./useNeedsYou";
import { useAutoFit } from "./autoFit";

export interface TopBarProps {
  /** Scroll to / open the Needs-you panel (desktop) or list (mobile). */
  onOpenNeedsYou?: () => void;
  /** Account control; defaults to the avatar menu with sign-out. */
  account?: ReactNode;
  accountName?: string | null;
  accountRole?: Role | null;
  accountRoles?: ProfileRole[];
  currentProfile?: string;
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
  account,
  accountName,
  accountRole,
  accountRoles,
  currentProfile,
}: TopBarProps & TopBarData) {
  const build = buildInfo(status.summary);
  const barRef = useAutoFit<HTMLElement>();
  return (
    <div data-component="TopBar" data-build-mismatch={build.buildMismatch || undefined}>
      <header
        ref={barRef}
        data-testid="top-bar-row"
        className="flex h-14 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 lg:gap-4"
      >
        <div data-component="brand" className="flex shrink-0 items-center gap-2">
          <Link href="/" aria-label="Aquarium home" data-action="home" className="flex items-center gap-2 rounded-[var(--radius-md)]">
            <AquariumMark size={24} title="" />
            <span data-fit-hide="brand-label" className="text-sm font-semibold text-[var(--color-fg)]">
              Aquarium
            </span>
          </Link>
        </div>
        <div data-fit-hide="health" className="hidden min-w-0 lg:flex">
          <HealthPill variant="bar" status={status} activity={activity} />
        </div>
        <div data-fit-show="health" className="hidden shrink-0 items-center">
          <HealthPill variant="compact" status={status} activity={activity} />
        </div>
        <div aria-hidden className="flex-1" />
        <Link
          href="/aquarium"
          data-action="open-aquarium"
          aria-label="Open the Aquarium dashboard"
          title="Open the Aquarium dashboard"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
        >
          <AquariumMark size={16} title="" />
          <span aria-hidden="true" data-fit-hide="aquarium-label" className="hidden whitespace-nowrap sm:inline">
            Aquarium dashboard
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          <HealthPill variant="compact" status={status} activity={activity} />
          <NeedsYouBadge compact count={needsYou.count} stale={needsYou.stale} onOpen={onOpenNeedsYou} />
        </div>
        <div className="hidden shrink-0 lg:flex">
          <NeedsYouBadge count={needsYou.count} stale={needsYou.stale} onOpen={onOpenNeedsYou} />
        </div>
        {account ?? (
          <AccountMenu name={accountName} role={accountRole} roles={accountRoles} currentProfile={currentProfile} />
        )}
      </header>
      <RunningStripView
        items={activity.items}
        now={activity.now}
        stale={activity.stale}
        scheduled={activity.scheduled}
        className="hidden lg:flex"
      />
      <MobileActivityStrip
        items={activity.items}
        now={activity.now}
        stale={activity.stale}
        scheduled={activity.scheduled}
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
 * reading), Needs-you badge, account menu; on desktop the running strip with
 * the Scheduled button, on mobile the one-line activity strip and the amber
 * attention banner. Reuses the shared status / activity hooks, so their
 * caches are shared across pages.
 */
export function TopBar(props: TopBarProps) {
  const status = useStatusSummary();
  const activity = useActivityRunning();
  const needsYou = useNeedsYou();
  return <TopBarView {...props} status={status} activity={activity} needsYou={needsYou} />;
}
