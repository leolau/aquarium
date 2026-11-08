"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { useActivityRunning } from "@/components/ui/useActivityRunning";
import { useStatusSummary } from "@/components/ui/useStatusSummary";
import { useNeedsYou } from "@/lib/landing/needsYou";
import type { ProfileSummary } from "@/types";

import { ChatsDrawer, ChatsSidebar } from "./chats";
import { LandingComposer } from "./LandingComposer";
import { LandingLayout } from "./LandingLayout";
import { TopBarView } from "./topbar";
import { LandingWorkPanel, type NeedsYouFeed } from "./work";

/**
 * The interactive landing page. One needs-you poll feeds the top-bar badge,
 * the mobile banner, the greeting, the panel, the tab-title count and the app
 * badge, so they can never disagree.
 */
export function LandingClient({
  profiles,
  currentProfile,
  accountName,
}: {
  profiles: ProfileSummary[];
  currentProfile: string;
  accountName?: string | null;
}) {
  const status = useStatusSummary();
  const activity = useActivityRunning();
  const needsYou = useNeedsYou();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [needsYouOpen, setNeedsYouOpen] = useState(false);

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

  const openNeedsYou = () => {
    needsYou.markSeen();
    // Desktop shows the panel beside the composer; phones open it as a sheet.
    if (window.matchMedia("(min-width: 1024px)").matches) {
      document.getElementById("needs-you-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      setNeedsYouOpen(true);
    }
  };

  const chats = { profile: currentProfile, profiles };

  return (
    <>
      <LandingLayout
        topBar={
          <TopBarView
            status={status}
            activity={activity}
            needsYou={{
              count: needsYou.loading ? null : needsYou.count,
              blocking: needsYou.bySeverity.blocking,
              items: needsYou.items,
              stale: needsYou.stale,
            }}
            onOpenNeedsYou={openNeedsYou}
            onToggleSidebar={() => setDrawerOpen(true)}
            accountName={accountName}
          />
        }
        sidebar={<ChatsSidebar {...chats} />}
        main={
          <LandingComposer
            profiles={profiles}
            currentProfile={currentProfile}
            needsYouCount={needsYou.count}
            name={accountName}
          />
        }
        aside={<LandingWorkPanel needsYou={feed} />}
        dock={
          <div className="flex gap-2">
            <button
              type="button"
              data-action="open-chats"
              onClick={() => setDrawerOpen(true)}
              className="flex h-11 flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-medium"
            >
              Chats
            </button>
            <Link
              href="/chat?new=1"
              data-action="new-chat"
              className="flex h-11 flex-1 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-accent)] text-sm font-medium text-[var(--color-accent-fg)]"
            >
              + New chat
            </Link>
          </div>
        }
      />
      {needsYouOpen ? (
        <Sheet title="Needs you" component="NeedsYouSheet" onClose={() => setNeedsYouOpen(false)}>
          <LandingWorkPanel needsYou={feed} />
        </Sheet>
      ) : null}
      <ChatsDrawer {...chats} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
