"use client";

import { TopBarView } from "@/components/landing/topbar";
import { NeedsYouPanel, type NeedsYouFeed } from "@/components/landing/work";
import { Sheet } from "@/components/ui/Sheet";
import { useActivityRunning } from "@/components/ui/useActivityRunning";
import { useStatusSummary } from "@/components/ui/useStatusSummary";
import { useT } from "@/i18n";
import { useNeedsYou } from "@/lib/landing/needsYou";
import { useMemo, useState } from "react";
import type { ProfileRole } from "@/lib/api/my-profiles";
import type { Role } from "@/types";

/**
 * The landing top bar on every inner page: same health pill, Needs-you badge
 * (with the tab-title count) and account menu. The badge opens the Needs-you
 * list as a sheet, since inner pages have no right-hand panel.
 */
export function ShellTopBar({
  accountName,
  accountRole,
  accountRoles,
  currentProfile,
  compact = false,
}: {
  /** Phone chat layout: see `TopBarView`'s `compact`. */
  compact?: boolean;
  accountName?: string | null;
  accountRole?: Role | null;
  accountRoles?: ProfileRole[];
  currentProfile?: string;
}) {
  const status = useStatusSummary();
  const activity = useActivityRunning();
  const needsYou = useNeedsYou();
  const [open, setOpen] = useState(false);
  const tn = useT("needsYou");

  const feed: NeedsYouFeed = useMemo(
    () => ({
      items: needsYou.items,
      count: needsYou.count,
      newIds: new Set(needsYou.newIds),
      loaded: !needsYou.loading,
      stale: needsYou.stale,
      refresh: needsYou.refresh,
    }),
    [needsYou.items, needsYou.count, needsYou.newIds, needsYou.loading, needsYou.stale, needsYou.refresh],
  );

  return (
    <>
      <TopBarView
        compact={compact}
        status={status}
        activity={activity}
        needsYou={{
          count: needsYou.loading ? null : needsYou.count,
          blocking: needsYou.bySeverity.blocking,
          items: needsYou.items,
          stale: needsYou.stale,
        }}
        onOpenNeedsYou={() => {
          needsYou.markSeen();
          setOpen(true);
        }}
        accountName={accountName}
        accountRole={accountRole}
        accountRoles={accountRoles}
        currentProfile={currentProfile}
      />
      {open ? (
        <Sheet title={tn("heading")} component="NeedsYouSheet" onClose={() => setOpen(false)}>
          <NeedsYouPanel feed={feed} />
        </Sheet>
      ) : null}
    </>
  );
}
