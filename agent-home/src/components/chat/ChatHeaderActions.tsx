"use client";

import { useEffect, useState } from "react";

import { ArchiveIcon, CopyIcon, FilterIcon, InfoIcon, MessageIcon, MoreIcon, PlusIcon } from "@/components/ui/icons";
import { chatHeaderActionsRef, type ChatHeaderActionsRef } from "@/lib/chat/header-actions";

const MENU_ITEMS: { action: keyof ChatHeaderActionsRef; label: string; Icon: typeof InfoIcon }[] = [
  { action: "openChats", label: "All chats", Icon: MessageIcon },
  { action: "openDetails", label: "Details", Icon: InfoIcon },
  { action: "toggleFilters", label: "Filters & search", Icon: FilterIcon },
  { action: "copyChat", label: "Copy chat", Icon: CopyIcon },
  { action: "openArchived", label: "Archived", Icon: ArchiveIcon },
];

/**
 * The chat page's title-bar actions, next to the conversation title. Desktop
 * shows Details / Archived / + New as buttons. Phones keep one row: a 44px
 * "+" (new chat) and a "⋯" menu holding All chats, Details, Filters & search,
 * Copy chat and Archived — so a long title never pushes them onto a second row.
 *
 * The callbacks are populated by `ChatPane` via the shared
 * `chatHeaderActionsRef` — see `lib/chat/header-actions.ts` for the rationale.
 * The handlers read the ref at click time so they always invoke the latest
 * callback.
 */
export function ChatHeaderActions() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (copied === null) return;
    const id = window.setTimeout(() => {
      setCopied(null);
      setMenuOpen(false);
    }, 900);
    return () => window.clearTimeout(id);
  }, [copied]);

  const runMenuItem = (action: keyof ChatHeaderActionsRef) => {
    if (action === "copyChat") {
      void chatHeaderActionsRef.current.copyChat().then(setCopied);
      return;
    }
    setMenuOpen(false);
    chatHeaderActionsRef.current[action]();
  };

  return (
    <div data-component="ChatHeaderActions" className="flex items-center gap-1 lg:gap-2">
      <div className="hidden items-center gap-2 lg:flex">
        <button
          type="button"
          data-action="session-details"
          onClick={() => chatHeaderActionsRef.current.openDetails()}
          aria-label="Conversation details"
          title="Rename, category and tags"
          className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
        >
          Details
        </button>
        <button
          type="button"
          onClick={() => chatHeaderActionsRef.current.openArchived()}
          aria-label="Show archived conversations"
          title="Archived conversations"
          className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
        >
          Archived
        </button>
        <button
          type="button"
          onClick={() => chatHeaderActionsRef.current.startNew()}
          aria-label="New conversation"
          className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)]"
        >
          + New
        </button>
      </div>
      <div className="flex items-center gap-1 lg:hidden">
        <button
          type="button"
          data-action="new-chat"
          onClick={() => chatHeaderActionsRef.current.startNew()}
          aria-label="New conversation"
          title="New conversation"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
        >
          <PlusIcon size={20} />
        </button>
        <div className="relative">
          <button
            type="button"
            data-action="chat-menu"
            onClick={() => setMenuOpen((cur) => !cur)}
            aria-label="More chat actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]"
          >
            <MoreIcon size={20} />
          </button>
          {menuOpen ? (
            <>
              <div aria-hidden="true" className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div
                role="menu"
                aria-label="Chat actions"
                data-component="ChatHeaderMenu"
                className="absolute right-0 top-full z-50 mt-1 flex w-56 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
              >
                {MENU_ITEMS.map(({ action, label, Icon }) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    data-action={`chat-menu-${action}`}
                    onClick={() => runMenuItem(action)}
                    className="flex h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
                  >
                    <Icon size={18} className="text-[var(--color-muted)]" />
                    {action === "copyChat" && copied !== null ? (copied ? "Copied" : "Copy failed") : label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
