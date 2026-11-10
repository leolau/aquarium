"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { useActivityRunning } from "@/components/ui/useActivityRunning";
import { useStatusSummary } from "@/components/ui/useStatusSummary";
import { useIdleRedirect } from "@/lib/aquarium/useIdleRedirect";
import { useNeedsYou } from "@/lib/landing/needsYou";
import type { ProfileRole } from "@/lib/api/my-profiles";
import type { ProfileSummary, Role } from "@/types";

import { ChatsDrawer, ChatsSidebar } from "./chats";
import { chatsApi, landingChatHref } from "./chats/chatsApi";
import { highlightTermOf, type MessageSearchHit } from "./chats/MessageSearch";
import { displayTitle, type LandingSession } from "./chats/model";
import { LandingChatView } from "./LandingChatView";
import { LandingComposer } from "./LandingComposer";
import { LandingLayout } from "./LandingLayout";
import { TopBarView } from "./topbar";
import { useLandingPanels } from "./useLandingPanels";
import { LandingWorkPanel, type NeedsYouFeed } from "./work";

/** What the row or hit that opened a chat already knew about it. */
interface OpenedChat {
  id: string;
  title?: string | null;
  highlight?: string;
}

/**
 * The interactive landing page. One needs-you poll feeds the top-bar badge,
 * the mobile banner, the greeting, the panel, the tab-title count and the app
 * badge, so they can never disagree. A chat picked in the sidebar, the
 * drawer or message search opens in the centre column (`/?chat=<id>`, a
 * history push, so Back returns to the composer and a reload re-opens it).
 */
export function LandingClient({
  profiles,
  currentProfile,
  accountName,
  accountRole,
  accountRoles,
  storageEnabled = false,
}: {
  profiles: ProfileSummary[];
  currentProfile: string;
  accountName?: string | null;
  /** The signed-in principal's role in the current profile. */
  accountRole?: Role | null;
  /** Its role in every profile it is actively enrolled in. */
  accountRoles?: ProfileRole[];
  /** Attachments can be uploaded from the inline chat's composer. */
  storageEnabled?: boolean;
}) {
  const status = useStatusSummary();
  const activity = useActivityRunning();
  const needsYou = useNeedsYou();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [needsYouOpen, setNeedsYouOpen] = useState(false);
  const panels = useLandingPanels();

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
      const reveal = () =>
        document.getElementById("needs-you-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (panels.tasksCollapsed) {
        panels.setTasksCollapsed(false);
        requestAnimationFrame(reveal);
      } else {
        reveal();
      }
    } else {
      setNeedsYouOpen(true);
    }
  };

  const params = useSearchParams();
  const chatId = params?.get("chat") || null;
  const chatProfile = params?.get("profile") || currentProfile;
  const [opened, setOpened] = useState<OpenedChat | null>(null);
  const openedChat = opened?.id === chatId ? opened : null;
  const [renamed, setRenamed] = useState<{ id: string; title: string } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  useIdleRedirect({ blocked: Boolean(chatId) && chatBusy });

  const openChat = (id: string, profile: string, meta: Omit<OpenedChat, "id">) => {
    const href = landingChatHref(id, profile);
    // A second press (or Enter) on the open chat adds no history entry.
    if (window.location.pathname + window.location.search !== href) {
      window.history.pushState(null, "", href);
    }
    setOpened({ id, ...meta });
  };
  const openSession = (s: LandingSession) =>
    openChat(s.id, s.profile ?? currentProfile, { title: displayTitle(s).text });
  const openMessageHit = (hit: MessageSearchHit) =>
    openChat(hit.session_id, currentProfile, {
      title: hit.title,
      highlight: highlightTermOf(hit.snippet),
    });
  // Back follows the logical parent (Home's composer), never browser history.
  const closeChat = () => window.history.pushState(null, "", "/");

  const chats = {
    profile: currentProfile,
    profiles,
    activeSessionId: chatId,
    messageSearch: (q: string, signal: AbortSignal) =>
      chatsApi.searchMessages(q, signal, currentProfile),
    onOpenMessageHit: openMessageHit,
    onOpenChat: openSession,
    onRenamed: (s: LandingSession, title: string) => setRenamed({ id: s.id, title }),
  };

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
            accountName={accountName}
            accountRole={accountRole}
            accountRoles={accountRoles}
            currentProfile={currentProfile}
          />
        }
        sidebar={<ChatsSidebar {...chats} />}
        main={
          chatId ? (
            <LandingChatView
              key={`${chatProfile}:${chatId}:${openedChat?.highlight ?? ""}`}
              sessionId={chatId}
              profile={chatProfile}
              title={openedChat?.title}
              renamedTitle={renamed?.id === chatId ? renamed.title : undefined}
              highlight={openedChat?.highlight}
              storageEnabled={storageEnabled}
              onBusyChange={setChatBusy}
              onClose={closeChat}
            />
          ) : (
            <LandingComposer
              profiles={profiles}
              currentProfile={currentProfile}
              needsYouCount={needsYou.count}
              name={accountName}
            />
          )
        }
        aside={<LandingWorkPanel needsYou={feed} />}
        chats={{ collapsed: panels.chatsCollapsed, onCollapsedChange: panels.setChatsCollapsed }}
        tasks={{ collapsed: panels.tasksCollapsed, onCollapsedChange: panels.setTasksCollapsed }}
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
