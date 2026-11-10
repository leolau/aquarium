"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { RefBadge } from "@/components/refs/RefBadge";
import { ArchiveIcon, ClockIcon, PencilIcon, PinIcon } from "@/components/ui/icons";
import { displayTitle, isPinned, lastUpdated, sessionOwner, type LandingSession } from "./model";

/** Row actions take no room until the row is hovered or focused (always shown on touch). */
const revealOnHover = "hidden group-hover:grid group-focus-within:grid [@media(hover:none)]:grid";

/**
 * One conversation in the sidebar (Figma `session-row` 3:76, states
 * Default / Active / Pinned / Live / Resume). The pencil swaps the title for an input:
 * Enter saves, Esc or leaving the field cancels. An untitled chat shows its
 * preview in muted italics until the agent's title arrives. Every row shows
 * when the chat was last updated; Archive hides it from the list. `resume`
 * marks the chat to pick up again (the latest one, while none is open) with
 * an accent outline and a "Continue" badge.
 */
export function SessionRow({
  session,
  href,
  profileLabel,
  active = false,
  resume = false,
  canPin = false,
  busy = false,
  onTogglePin,
  onRename,
  onArchive,
  onNavigate,
  onOpen,
  now,
}: {
  session: LandingSession;
  href: string;
  profileLabel: string;
  active?: boolean;
  /** The chat to continue: shown with a "Continue" badge (ignored while `active`). */
  resume?: boolean;
  canPin?: boolean;
  busy?: boolean;
  onTogglePin?: (session: LandingSession) => void;
  /** Resolves true when the new title was saved. */
  onRename?: (session: LandingSession, title: string) => Promise<boolean>;
  onArchive?: (session: LandingSession) => void;
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
  const updated = lastUpdated(session, now);

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

  const resuming = resume && !active;
  const state = active ? "active" : resuming ? "resume" : live ? "live" : pinned ? "pinned" : "default";

  return (
    <li
      data-component="SessionRow"
      data-state={state}
      className={`group relative flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 transition-colors ${
        active
          ? "bg-[var(--color-surface-2)]"
          : resuming
            ? "bg-[var(--color-surface)] ring-1 ring-inset ring-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
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
          <span className="flex min-w-0 items-center gap-1.5">
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
              title={resuming ? "Continue your last chat" : undefined}
              className="min-w-0 truncate text-[13px] font-medium leading-[18px] text-[var(--color-fg)] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-lg)] focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]"
            >
              <span
                data-slot="session-title"
                className={untitled ? "italic text-[var(--color-muted)]" : undefined}
              >
                {text}
              </span>
              {resuming ? <span className="sr-only"> — continue your last chat</span> : null}
            </Link>
            {resuming ? (
              <span
                data-slot="continue-badge"
                aria-hidden="true"
                className="shrink-0 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--color-accent-fg)]"
              >
                Continue
              </span>
            ) : null}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium leading-4 text-[var(--color-muted)]">
          <span data-slot="session-meta" className="min-w-0 truncate">
            {sessionOwner(session, profileLabel)}
          </span>
          <RefBadge value={session.ref} className="relative z-10 lg:!min-h-0" />
          {updated ? (
            <time
              data-slot="session-updated"
              dateTime={updated.iso}
              title={`Last updated ${updated.full}`}
              className="relative z-10 ml-auto inline-flex shrink-0 cursor-default items-center gap-1 tabular-nums"
            >
              <ClockIcon size={11} />
              <span className="sr-only">Last updated </span>
              {updated.label}
            </time>
          ) : null}
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

      {!editing && onArchive ? (
        <button
          type="button"
          onClick={() => onArchive(session)}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={`Archive “${text}”`}
          title="Archive"
          className={`relative z-10 size-6 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50 lg:!min-h-0 ${revealOnHover}`}
        >
          <ArchiveIcon size={14} />
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
