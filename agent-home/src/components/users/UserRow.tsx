"use client";

import { useState } from "react";

import { ASSIGNABLE_ROLES } from "@/components/users/CreateUserForm";
import type { Member, Role } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * One roster row and its management controls.
 *
 * Two independent states are shown because they mean different things and the
 * remedies differ: the **account** is box-wide (a banned account is what a
 * created-but-not-activated user looks like, fixed with an activation link),
 * while the **enrolment** is this profile's (suspended here, fixed with
 * Restore). Collapsing them would send an admin to the wrong control.
 *
 * The owner row is read-only — `owner` cannot be created or assigned here, and
 * ownership moves via `hermes owner transfer`. The self row hides role and
 * removal controls: an admin who demotes or deletes themselves locks the
 * console, and Python refuses these regardless.
 */
export function UserRow({
  member,
  self,
  canDelete,
  busy,
  onChangeRole,
  onSetEnrolled,
  onInvite,
  onRevokeInvite,
  onRename,
  onLinkChannel,
  onDelete,
}: {
  member: Member;
  /** True when this row is the acting principal. */
  self: boolean;
  /** Hard delete is owner-only: the account is shared across profiles. */
  canDelete: boolean;
  busy: boolean;
  onChangeRole: (m: Member, r: Role) => void;
  onSetEnrolled: (m: Member, enrolled: boolean) => unknown;
  onInvite: (m: Member) => unknown;
  onRevokeInvite: (m: Member) => unknown;
  onRename: (m: Member, display: string) => unknown;
  onLinkChannel: (m: Member, platform: string, channelUserId: string) => unknown;
  onDelete: (m: Member) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [display, setDisplay] = useState(member.display);
  const [platform, setPlatform] = useState("telegram");
  const [handle, setHandle] = useState("");

  const invitation = member.invitation;
  // A reset *request* mints a recovery invitation whose token is never returned
  // to anybody — by design, since the requester is unauthenticated. So "invite
  // open" would tell an admin a live link exists when none was ever handed out,
  // and they must still regenerate one.
  const resetRequested =
    invitation !== null &&
    invitation.kind === "recovery" &&
    invitation.status === "open";

  return (
    <li
      data-component="UserRow"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {member.display || member.email || member.user_id}
          {self ? <span className="text-[var(--color-muted)]"> (you)</span> : null}
        </p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {member.email || "(no email)"} · {member.user_id}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-[var(--color-accent)] px-2 py-1 text-[var(--color-accent-fg)]">
            {member.role}
          </span>
          {member.enrolled ? null : (
            <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-warn-text)]">
              suspended here
            </span>
          )}
          {member.active ? null : (
            <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-red-300">
              {invitation && invitation.status === "open"
                ? "awaiting activation"
                : "account locked"}
            </span>
          )}
          {invitation ? (
            <span
              title={
                resetRequested
                  ? "This person asked to reset their password. No link has been handed over — regenerate one."
                  : undefined
              }
              className="rounded-full bg-[var(--color-surface-2)] px-2 py-1"
            >
              {resetRequested ? "reset requested" : `invite ${invitation.status}`}
            </span>
          ) : null}
          {member.channels.map((c) => (
            <span key={c} className="rounded-full bg-[var(--color-surface-2)] px-2 py-1">
              {c}
            </span>
          ))}
        </div>
      </div>

      {member.is_owner ? (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Owner — managed via <code>hermes owner transfer</code>.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {self ? (
            <span className="text-xs text-[var(--color-muted)]">
              Your own role and enrolment are managed by another admin.
            </span>
          ) : (
            <>
              <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                Role
                <select
                  aria-label={`Role for ${member.display || member.user_id}`}
                  value={member.role}
                  disabled={busy}
                  onChange={(e) => onChangeRole(member, e.target.value as Role)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs disabled:opacity-50"
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <ActionButton
                disabled={busy}
                onAction={() => onSetEnrolled(member, !member.enrolled)}
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
              >
                {member.enrolled ? "Suspend" : "Restore"}
              </ActionButton>
            </>
          )}
          <ActionButton
            disabled={busy}
            onAction={() => onInvite(member)}
            className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
          >
            {resetRequested
              ? "Send reset link"
              : invitation
                ? "Regenerate link"
                : "Send link"}
          </ActionButton>
          {invitation && invitation.status === "open" ? (
            <ActionButton
              disabled={busy}
              onAction={() => onRevokeInvite(member)}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
            >
              Revoke link
            </ActionButton>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs"
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        </div>
      )}

      {expanded && !member.is_owner ? (
        <div
          data-component="UserRowDetails"
          className="mt-3 flex flex-col gap-3 border-t border-[var(--color-border)] pt-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label={`Display name for ${member.user_id}`}
              value={display}
              onChange={(e) => setDisplay(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            />
            <ActionButton
              disabled={busy || !display.trim() || display === member.display}
              onAction={() => onRename(member, display.trim())}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
            >
              Rename
            </ActionButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Channel platform for ${member.user_id}`}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            >
              {["telegram", "discord", "slack", "email", "whatsapp"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label={`Channel handle for ${member.user_id}`}
              placeholder="channel user id"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            />
            <ActionButton
              disabled={busy || !handle.trim()}
              onAction={() => {
                onLinkChannel(member, platform, handle.trim());
                setHandle("");
              }}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
            >
              Link channel
            </ActionButton>
          </div>
          {canDelete && !self ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(member)}
              className="self-start rounded-lg bg-red-500/15 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
            >
              Remove from profile…
            </button>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              {self
                ? "You cannot remove your own enrolment."
                : "Only the owner can remove a user: the account is shared across profiles."}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}
