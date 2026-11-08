"use client";

import { useMemo, useState } from "react";

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
    document.getElementById("needs-you-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    needsYou.markSeen();
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
      />
      <ChatsDrawer {...chats} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
