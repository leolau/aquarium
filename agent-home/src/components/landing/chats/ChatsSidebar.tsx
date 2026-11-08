"use client";

import { ChatsPanel, type ChatsPanelProps } from "./ChatsPanel";

/**
 * Desktop chats sidebar (Figma `5:2` → `sessions-sidebar`). Fills
 * `LandingLayout`'s `sidebar` slot, which supplies the `<aside>`, width and
 * border; ⌘K focuses its search.
 */
export function ChatsSidebar(props: ChatsPanelProps) {
  return (
    <div data-component="ChatsSidebar" className="flex h-full min-h-0 flex-col px-3 py-4">
      <ChatsPanel {...props} searchShortcut searchId="landing-sidebar-chat-search" />
    </div>
  );
}
