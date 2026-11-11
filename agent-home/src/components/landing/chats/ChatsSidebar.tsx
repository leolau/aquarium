"use client";

import { ChatsPanel, type ChatsPanelProps } from "./ChatsPanel";
import { LeftPanelTabs, type LeftTabsSlot } from "./LeftPanelTabs";

/**
 * Desktop chats sidebar (Figma `5:2` → `sessions-sidebar`). Fills
 * `LandingLayout`'s `sidebar` slot, which supplies the `<aside>`, width and
 * border; ⌘K focuses its search (`"hint"`: the page binds the key itself).
 * With `leftTabs` it gains the Chats | Incomings switch (plan A.1); the
 * chats list stays mounted while hidden so its scroll and search survive.
 */
export function ChatsSidebar({
  searchShortcut = true,
  leftTabs,
  ...props
}: ChatsPanelProps & { searchShortcut?: boolean | "hint"; leftTabs?: LeftTabsSlot }) {
  const chats = (
    <ChatsPanel {...props} searchShortcut={searchShortcut} searchId="landing-sidebar-chat-search" />
  );
  if (!leftTabs) {
    return (
      <div data-component="ChatsSidebar" className="flex h-full min-h-0 flex-col px-3 py-4">
        {chats}
      </div>
    );
  }
  const onIncomings = leftTabs.tab === "incomings";
  return (
    <div
      data-component="ChatsSidebar"
      data-tab={leftTabs.tab}
      className="flex h-full min-h-0 flex-col gap-3 px-3 py-4"
    >
      <LeftPanelTabs
        value={leftTabs.tab}
        onChange={leftTabs.onTabChange}
        incomingsCount={leftTabs.count}
        urgent={leftTabs.urgent}
        idPrefix="landing-sidebar"
      />
      <div
        id="landing-sidebar-panel-chats"
        hidden={onIncomings}
        className="flex min-h-0 flex-1 flex-col"
      >
        {chats}
      </div>
      {onIncomings ? (
        <div id="landing-sidebar-panel-incomings" className="flex min-h-0 flex-1 flex-col">
          {leftTabs.renderIncomings({ inDrawer: false })}
        </div>
      ) : null}
    </div>
  );
}
