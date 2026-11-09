"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { PencilIcon, PinIcon } from "@/components/ui/icons";
import { displayTitle, isPinned, sessionMeta, type LandingSession } from "./model";

/** Row actions take no room until the row is hovered or focused (always shown on touch). */
const revealOnHover = "hidden group-hover:grid group-focus-within:grid [@media(hover:none)]:grid";

/**
 * One conversation in the sidebar (Figma `session-row` 3:76, states
 * Default / Active / Pinned / Live). The pencil swaps the title for an input:
 * Enter saves, Esc or leaving the field cancels. An untitled chat shows its
 * preview in muted italics until the agent's title arrives.
 */
export function SessionRow({
  session,
  href,
  profileLabel,
  active = false,
  canPin = false,
  busy = false,
  onTogglePin,
  onRename,
  onNavigate,
  onOpen,
  now,
}: {
  session: LandingSession;
  href: string;
  profileLabel: string;
  active?: boolean;
  canPin?: boolean;
  busy?: boolean;
  onTogglePin?: (session: LandingSession) => void;
  /** Resolves true when the new title was saved. */
  onRename?: (session: LandingSession, title: string) => Promise<boolean>;
  onNavigate?: () => void;
  /** Open the chat in place instead of following `href` (a plain click or
   * Enter; modified clicks still open the full page). */
  onOpen?: (session: LandingSession) => void;
  now?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { text, untitled } = displayTitle(session);
  const pinned = canPin && isPinned(session);
  const live = Boolean(session.is_active);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function startEdit() {
    setDraft(session.title ?? "");
    setEditing(true);
  }

  async function save() {
    if (!onRename) return setEditing(false);
    const ok = await onRename(session, draft);
    if (ok) setEditing(false);
    else input.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  }

  const state = active ? "active" : live ? "live" : pinned ? "pinned" : "default";

  return (
    <li
      data-component="SessionRow"
      data-state={state}
      className={`group relative flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 transition-colors ${
        active
          ? "bg-[var(--color-surface-2)]"
          : "hover:bg-[var(--color-surface)] focus-within:bg-[var(--color-surface)]"
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <input
            ref={input}
            value={draft}
            disabled={busy}
            aria-label="Chat title"
            placeholder={untitled ? text : "Chat title"}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!busy) setEditing(false);
            }}
            className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-accent)] lg:!min-h-0 bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] font-medium leading-[18px] text-[var(--color-fg)] outline-none disabled:opacity-60"
          />
        ) : (
          <Link
            href={href}
            onClick={(e) => {
              if (onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
                e.preventDefault();
                onOpen(session);
              }
              onNavigate?.();
            }}
            aria-current={active ? "page" : undefined}
            className="min-w-0 truncate text-[13px] font-medium leading-[18px] text-[var(--color-fg)] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-lg)] focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]"
          >
            <span
              data-slot="session-title"
              className={untitled ? "italic text-[var(--color-muted)]" : undefined}
            >
              {text}
            </span>
          </Link>
        )}
        <span
          data-slot="session-meta"
          className="truncate text-xs font-medium leading-4 text-[var(--color-muted)]"
        >
          {sessionMeta(session, profileLabel, now)}
        </span>
      </div>

      {live && !editing ? (
        <span
          data-slot="live-dot"
          role="img"
          aria-label="Working now"
          className="size-2 shrink-0 rounded-full bg-[var(--color-accent)] motion-safe:animate-pulse"
        />
      ) : null}

      {!editing && onRename ? (
        <button
          type="button"
          onClick={startEdit}
          disabled={busy}
          aria-label={`Rename “${text}”`}
          title="Rename"
          className={`relative z-10 size-6 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50 lg:!min-h-0 ${revealOnHover}`}
        >
          <PencilIcon size={14} />
        </button>
      ) : null}

      {!editing && canPin && onTogglePin ? (
        <button
          type="button"
          onClick={() => onTogglePin(session)}
          disabled={busy}
          aria-pressed={pinned}
          aria-busy={busy || undefined}
          aria-label={pinned ? `Unpin “${text}”` : `Pin “${text}”`}
          title={pinned ? "Unpin" : "Pin"}
          className={`relative z-10 size-6 shrink-0 place-items-center rounded-[var(--radius-sm)] disabled:opacity-50 lg:!min-h-0 ${
            pinned
              ? "grid text-[var(--color-accent)]"
              : `text-[var(--color-muted)] hover:text-[var(--color-fg)] ${revealOnHover}`
          }`}
        >
          <PinIcon size={14} filled={pinned} />
        </button>
      ) : null}
    </li>
  );
}
