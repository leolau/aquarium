"use client";

import { useEffect, useRef } from "react";

import { ChatsPanel, type ChatsPanelProps } from "./ChatsPanel";
import { LeftPanelTabs, type LeftTabsSlot } from "./LeftPanelTabs";
import { XIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";

/**
 * Mobile Chats drawer (Figma `6:195`): the sidebar's contents in a
 * full-height panel from the left. Esc, ✕, the backdrop and opening a chat
 * all close it. Renders nothing while closed, so nothing is fetched.
 * `focusSearch` puts the cursor in its search instead of on ✕ when it opens.
 * With `leftTabs` it carries the same Chats | Incomings switch as the
 * desktop sidebar, and its title follows the tab.
 */
export function ChatsDrawer({
  open,
  onClose,
  focusSearch = false,
  leftTabs,
  ...panel
}: ChatsPanelProps & {
  open: boolean;
  onClose: () => void;
  focusSearch?: boolean;
  leftTabs?: LeftTabsSlot;
}) {
  const t = useT("incomings");
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement as HTMLElement | null;
    const search = focusSearch
      ? panelRef.current?.querySelector<HTMLInputElement>('[data-component="SessionSearch"] input')
      : null;
    (search ?? closeRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onClose, focusSearch]);

  if (!open) return null;

  return (
    <div
      data-component="ChatsDrawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-chats-drawer-title"
      className="fixed inset-0 z-[70] flex bg-black/60"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="flex h-full w-full max-w-md flex-col gap-2 border-r border-[var(--color-border)] bg-[var(--color-bg)] px-3 pb-[calc(var(--safe-bottom,0px)+1rem)] pt-[calc(var(--safe-top,0px)+1rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 pl-1">
          <h2
            id="landing-chats-drawer-title"
            className="flex-1 text-lg font-semibold leading-6 text-[var(--color-fg)]"
          >
            {leftTabs?.tab === "incomings" ? t("tabs.incomings") : t("tabs.chats")}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("actions.closeDrawer")}
            className="grid size-11 place-items-center rounded-[var(--radius-md)] text-[var(--color-muted)] outline-none hover:text-[var(--color-fg)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <XIcon size={20} />
          </button>
        </div>
        {leftTabs ? (
          <LeftPanelTabs
            value={leftTabs.tab}
            onChange={leftTabs.onTabChange}
            incomingsCount={leftTabs.count}
            urgent={leftTabs.urgent}
            idPrefix="landing-drawer"
          />
        ) : null}
        {leftTabs?.tab === "incomings" ? (
          <div id="landing-drawer-panel-incomings" className="flex min-h-0 flex-1 flex-col">
            {leftTabs.renderIncomings({ onNavigate: onClose, inDrawer: true })}
          </div>
        ) : (
          <div id="landing-drawer-panel-chats" className="flex min-h-0 flex-1 flex-col gap-2">
            <ChatsPanel {...panel} onNavigate={onClose} searchId="landing-drawer-chat-search" />
          </div>
        )}
      </div>
    </div>
  );
}
