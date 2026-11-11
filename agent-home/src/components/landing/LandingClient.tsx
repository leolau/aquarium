"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Sheet } from "@/components/ui/Sheet";
import { useActivityRunning } from "@/components/ui/useActivityRunning";
import { useStatusSummary } from "@/components/ui/useStatusSummary";
import { useIdleRedirect } from "@/lib/aquarium/useIdleRedirect";
import { useNeedsYou } from "@/lib/landing/needsYou";
import {
  attentionErrorKey,
  incomingSender,
  incomingTitle,
  useIncomings,
  useIncomingsAttention,
} from "@/lib/landing/incomings";
import { UNDO_MS, useUndoToast } from "@/components/ui/UndoToast";
import { useT } from "@/i18n";
import type { ProfileRole } from "@/lib/api/my-profiles";
import type { IncomingItem, ProfileSummary, Role } from "@/types";

import { ChatsDrawer, ChatsSidebar, useLeftPanelTab, type LeftTabsSlot } from "./chats";
import { chatsApi, landingChatHref } from "./chats/chatsApi";
import { highlightTermOf, type MessageSearchHit } from "./chats/MessageSearch";
import { displayTitle, type LandingSession } from "./chats/model";
import { LandingChatView } from "./LandingChatView";
import { LandingComposer } from "./LandingComposer";
import { IncomingsPanel, LandingIncomingView } from "./incomings";
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
 * badge, so they can never disagree; likewise one activity poll feeds the
 * running strip, the mobile activity strip and "Working in the background". A chat picked in the sidebar, the
 * drawer or message search opens in the centre column (`/?chat=<id>`, a
 * history push, so Back returns to the composer and a reload re-opens it).
 * The sidebar's Incomings tab (plan A.1) works the same way: a row opens in
 * the centre (`/?incoming=<id>`); on phones the drawer's rows go to
 * `/inbox/<id>?from=landing`. `/?panel=incomings` selects the tab.
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
  const incomingId = chatId ? null : params?.get("incoming") || null;
  const panelParam = params?.get("panel");
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

  const ti = useT("incomings");
  const [storedTab, storeTab] = useLeftPanelTab();
  // `/?panel=incomings` shows the tab until the user picks one themselves.
  const [tabPicked, setTabPicked] = useState(false);
  const deepLinked = panelParam === "incomings" && !tabPicked;
  const leftTab = deepLinked ? "incomings" : storedTab;
  const pickTab = (tab: typeof storedTab) => {
    setTabPicked(true);
    storeTab(tab);
  };
  useEffect(() => {
    if (panelParam !== "incomings") return;
    // Phones have no sidebar: the deep link opens the drawer on the tab.
    const frame = window.requestAnimationFrame(() => {
      if (!window.matchMedia("(min-width: 1024px)").matches) setDrawerOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelParam]);
  const attention = useIncomingsAttention(currentProfile);
  const incomings = useIncomings({
    profile: currentProfile,
    enabled: leftTab === "incomings" || Boolean(incomingId),
  });
  const [openedIncoming, setOpenedIncoming] = useState<IncomingItem | null>(null);
  const [incomingError, setIncomingError] = useState<string | null>(null);
  const undo = useUndoToast();
  useEffect(() => {
    if (!incomingError) return;
    const timer = window.setTimeout(() => setIncomingError(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [incomingError]);

  const openIncoming = (item: IncomingItem) => {
    const href = `/?incoming=${encodeURIComponent(item.id)}`;
    if (window.location.pathname + window.location.search !== href) {
      window.history.pushState(null, "", href);
    }
    setOpenedIncoming(item);
  };
  const markIncomingDone = async (item: IncomingItem) => {
    setIncomingError(null);
    if (incomingId === item.id) closeChat();
    const res = await incomings.clear(item, "done");
    if (!res.ok) {
      setIncomingError(ti(attentionErrorKey(res)));
      return;
    }
    const who = incomingSender(item) || incomingTitle(item) || item.ref || item.id;
    undo.show(ti("toast.done", { who }), async () => {
      const back = await incomings.reopen(item);
      if (!back.ok) setIncomingError(ti(attentionErrorKey(back)));
    });
  };

  const leftTabs: LeftTabsSlot = {
    tab: leftTab,
    onTabChange: pickTab,
    count: attention.count,
    urgent: attention.urgent,
    renderIncomings: ({ onNavigate, inDrawer }) => (
      <IncomingsPanel
        incomings={incomings}
        activeId={inDrawer ? null : incomingId}
        onOpen={inDrawer ? undefined : openIncoming}
        onDone={(item) => void markIncomingDone(item)}
        onNavigate={onNavigate}
      />
    ),
  };

  const chats = {
    profile: currentProfile,
    profiles,
    activeSessionId: chatId,
    userChatsOnly: true,
    highlightLatest: true,
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
        sidebar={<ChatsSidebar {...chats} leftTabs={leftTabs} />}
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
          ) : incomingId ? (
            <LandingIncomingView
              key={incomingId}
              id={incomingId}
              item={openedIncoming?.id === incomingId ? openedIncoming : incomings.items.find((i) => i.id === incomingId)}
              onClose={closeChat}
              onDone={(item) => void markIncomingDone(item)}
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
        aside={<LandingWorkPanel needsYou={feed} activity={activity} />}
        chats={{
          collapsed: panels.chatsCollapsed,
          onCollapsedChange: panels.setChatsCollapsed,
          badge: attention.count,
          badgeUrgent: attention.urgent > 0,
        }}
        tasks={{ collapsed: panels.tasksCollapsed, onCollapsedChange: panels.setTasksCollapsed }}
        dock={
          <div className="flex gap-2">
            <button
              type="button"
              data-action="open-chats"
              onClick={() => setDrawerOpen(true)}
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-medium"
            >
              Chats
              {attention.count ? (
                <span
                  data-slot="incomings-count"
                  aria-label={ti("tabs.countLabel", { count: attention.count })}
                  className={`rounded-full px-1.5 text-[10px] font-bold leading-4 tabular-nums ${
                    attention.urgent > 0
                      ? "bg-[var(--color-danger)] text-white"
                      : "bg-[var(--color-warn)] text-[var(--color-bg)]"
                  }`}
                >
                  {attention.count >= 99 ? "99+" : attention.count}
                </span>
              ) : null}
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
          <LandingWorkPanel needsYou={feed} activity={activity} />
        </Sheet>
      ) : null}
      <ChatsDrawer
        {...chats}
        leftTabs={leftTabs}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      {undo.toast}
      {incomingError ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--coral-clearance)+var(--safe-bottom)+4rem)] z-[60] flex justify-center px-4 lg:bottom-20">
          <p
            role="alert"
            data-component="IncomingsErrorToast"
            className="pointer-events-auto w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--color-danger)] bg-[var(--color-surface-2)] px-4 py-2 text-sm text-[var(--color-fg)] shadow-lg"
          >
            {incomingError}
          </p>
        </div>
      ) : null}
    </>
  );
}
