"use client";

import { useState } from "react";

import { ASSIGNABLE_ROLES } from "@/components/users/CreateUserForm";
import { ProfileRolesPanel } from "@/components/users/ProfileRolesPanel";
import { ActionButton } from "@/components/ui/ActionButton";
import { Sheet } from "@/components/ui/Sheet";
import { useT } from "@/i18n/client";
import type { Member, Role } from "@/types";

/**
 * One person on the Users screen. The owner row has no role select or
 * suspend (ownership moves via `hermes owner transfer`). An owner or admin may
 * re-role, suspend/restore, issue or revoke an activation link, rename, link a
 * channel and remove the enrolment. A picked role is only staged until Save
 * role. On phones the secondary actions collapse into a "More" sheet.
 *
 * "Profiles & roles" opens the person's enrolments across every profile the
 * actor administers.
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
  onProfilesChanged,
}: {
  member: Member;
  /** True when this row is the acting principal. */
  self: boolean;
  /** Removal from this profile (owner/admin; the box-wide account is kept). */
  canDelete: boolean;
  busy: boolean;
  /** Saves an explicitly picked role; picking alone never saves. */
  onChangeRole: (m: Member, r: Role) => unknown;
  onSetEnrolled: (m: Member, enrolled: boolean) => unknown;
  onInvite: (m: Member) => unknown;
  onRevokeInvite: (m: Member) => unknown;
  onRename: (m: Member, display: string) => unknown;
  onLinkChannel: (m: Member, platform: string, channelUserId: string) => unknown;
  onDelete: (m: Member) => void;
  /** A "Profiles & roles" change landed in `profile`. */
  onProfilesChanged?: (profile: string, removedSelf: boolean) => unknown;
}) {
  const t = useT("users");
  const [expanded, setExpanded] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [picked, setPicked] = useState<Role | null>(null);
  const [display, setDisplay] = useState(member.display);
  const [platform, setPlatform] = useState("telegram");
  const [handle, setHandle] = useState("");
  const shownRole = picked ?? member.role;
  const roleDirty = picked !== null && picked !== member.role;
  const name = member.display || member.email || member.user_id;

  const invitation = member.invitation;
  // A reset *request* mints a recovery invitation whose token is never returned
  // to anybody — by design, since the requester is unauthenticated. So "invite
  // open" would tell an admin a live link exists when none was ever handed out,
  // and they must still regenerate one.
  const resetRequested =
    invitation !== null && invitation.kind === "recovery" && invitation.status === "open";

  const chip = "rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50";
  const sheetItem =
    "flex min-h-11 w-full items-center rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] px-4 text-left text-sm disabled:opacity-50";

  function profilesToggle(cls: string, after?: () => void) {
    return (
      <button
        type="button"
        aria-expanded={profilesOpen}
        onClick={() => {
          after?.();
          setProfilesOpen(!profilesOpen);
        }}
        className={cls}
      >
        {profilesOpen ? t("row.hideProfiles") : t("row.profiles")}
      </button>
    );
  }

  /** Link, revoke, details and profiles: inline from `sm`, in the More sheet on phones. */
  function secondary(inSheet: boolean) {
    const cls = inSheet ? sheetItem : chip;
    const close = () => {
      if (inSheet) setMoreOpen(false);
    };
    return (
      <>
        <ActionButton
          disabled={busy}
          onAction={async () => {
            close();
            await onInvite(member);
          }}
          className={cls}
        >
          {resetRequested ? t("row.sendReset") : invitation ? t("row.regenerate") : t("row.sendLink")}
        </ActionButton>
        {invitation && invitation.status === "open" ? (
          <ActionButton
            disabled={busy}
            onAction={async () => {
              close();
              await onRevokeInvite(member);
            }}
            className={cls}
          >
            {t("row.revoke")}
          </ActionButton>
        ) : null}
        <button
          type="button"
          onClick={() => {
            close();
            setExpanded(!expanded);
          }}
          className={cls}
        >
          {expanded ? t("row.hideDetails") : t("row.details")}
        </button>
        {profilesToggle(cls, close)}
      </>
    );
  }

  return (
    <li
      data-component="UserRow"
      className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">
          {name}
          {self ? <span className="text-[var(--color-muted)]"> {t("row.you")}</span> : null}
        </p>
        <p className="break-all text-xs text-[var(--color-muted)]">
          {member.email || t("row.noEmail")} · {member.user_id}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-[var(--color-accent)] px-2 py-1 text-[var(--color-accent-fg)]">
            {t(`role.${member.role}`)}
          </span>
          {member.enrolled ? null : (
            <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-warn-text)]">
              {t("row.suspended")}
            </span>
          )}
          {member.active ? null : (
            <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-danger)]">
              {invitation && invitation.status === "open" ? t("row.awaiting") : t("row.locked")}
            </span>
          )}
          {invitation ? (
            <span
              title={resetRequested ? t("row.resetTitle") : undefined}
              className="rounded-full bg-[var(--color-surface-2)] px-2 py-1"
            >
              {resetRequested ? t("row.resetRequested") : t("row.invite", { status: invitation.status })}
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-[var(--color-muted)]">
            {t("row.ownerNote")} <code>hermes owner transfer</code>.
          </p>
          {profilesToggle(chip)}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            {t("row.role")}
            <select
              aria-label={t("row.roleFor", { name: member.display || member.user_id })}
              value={shownRole}
              disabled={busy}
              onChange={(e) => setPicked(e.target.value as Role)}
              className={`rounded-lg border bg-[var(--color-bg)] px-2 py-1 text-xs disabled:opacity-50 ${roleDirty ? "border-[var(--color-warn)]" : "border-[var(--color-border)]"}`}
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </label>
          {roleDirty ? (
            <>
              <span className="flex basis-full items-center gap-1.5 text-xs text-[var(--color-warn-text)] sm:basis-auto">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-warn)]" />
                {t("row.changedFrom", { role: t(`role.${member.role}`) })}
              </span>
              <ActionButton
                data-action="save-role"
                disabled={busy}
                onAction={async () => {
                  await onChangeRole(member, picked as Role);
                  setPicked(null);
                }}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {t("row.saveRole")}
              </ActionButton>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPicked(null)}
                className="rounded-lg px-2 py-1 text-xs text-[var(--color-muted)] disabled:opacity-50"
              >
                {t("row.cancel")}
              </button>
            </>
          ) : null}
          {self ? null : (
            <ActionButton
              disabled={busy}
              onAction={() => onSetEnrolled(member, !member.enrolled)}
              className={chip}
            >
              {member.enrolled ? t("row.suspend") : t("row.restore")}
            </ActionButton>
          )}
          <div className="hidden flex-wrap items-center gap-2 sm:flex">{secondary(false)}</div>
          <button
            type="button"
            data-action="user-more"
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => setMoreOpen(true)}
            className="rounded-lg px-3 py-1 text-xs text-[var(--color-muted)] disabled:opacity-50 sm:hidden"
          >
            {t("row.more")}
          </button>
        </div>
      )}

      {moreOpen ? (
        <Sheet title={t("row.moreTitle", { name })} onClose={() => setMoreOpen(false)} component="UserMoreSheet">
          <div className="flex flex-col gap-2">{secondary(true)}</div>
        </Sheet>
      ) : null}

      {profilesOpen ? (
        <ProfileRolesPanel member={member} self={self} onChanged={onProfilesChanged} />
      ) : null}

      {expanded && !member.is_owner ? (
        <div
          data-component="UserRowDetails"
          className="mt-3 flex flex-col gap-3 border-t border-[var(--color-border)] pt-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label={t("row.displayFor", { id: member.user_id })}
              value={display}
              onChange={(e) => setDisplay(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
            />
            <ActionButton
              disabled={busy || !display.trim() || display === member.display}
              onAction={() => onRename(member, display.trim())}
              className={chip}
            >
              {t("row.rename")}
            </ActionButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("row.platformFor", { id: member.user_id })}
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
              aria-label={t("row.handleFor", { id: member.user_id })}
              placeholder={t("row.handlePlaceholder")}
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
              className={chip}
            >
              {t("row.linkChannel")}
            </ActionButton>
          </div>
          {canDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(member)}
              className="self-start rounded-lg bg-[var(--color-danger)]/15 px-3 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
            >
              {t("row.remove")}
            </button>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">{t("row.removeOnlyAdmin")}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}
