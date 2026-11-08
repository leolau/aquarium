"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminProfileSwitcher } from "@/components/users/AdminProfileSwitcher";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill } from "@/components/ui/Pill";
import { CreateUserForm } from "@/components/users/CreateUserForm";
import { CsvImportPanel } from "@/components/users/CsvImportPanel";
import { DirectoryPanel } from "@/components/users/DirectoryPanel";
import { IdentityActivityPanel } from "@/components/users/IdentityActivityPanel";
import { InvitationLink } from "@/components/users/InvitationLink";
import { RemoveUserDialog } from "@/components/users/RemoveUserDialog";
import { UserRow } from "@/components/users/UserRow";
import { PAGE_SIZE, errorMessage, sendJson } from "@/components/users/api";
import { optimisticRoleChange } from "@/components/users/optimistic";
import { withProfileQuery } from "@/lib/profile";
import type {
  DirectoryResponse,
  Member,
  MemberCreateResponse,
  MemberInvitationResponse,
  MembersResponse,
  ProfileSummary,
  Role,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";
import { useUndoToast } from "@/components/ui/UndoToast";
import { useConfirm } from "@/components/ui/useConfirm";

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };


export interface UsersViewProps {
  /** The acting principal's role — decides which surfaces are even rendered. */
  role: Role;
  /** The acting principal, so its own row can protect itself. */
  userId: string;
  /**
   * The profile this console administers (FG-27 derives its schema from it).
   * Every members/directory request names it (`?profile=`), so the BFF and
   * Python judge the caller's role in *this* profile, not the session's.
   */
  profile: string;
  /** The profiles the caller administers — the switcher's options (FG-28 C3). */
  administered?: ProfileSummary[];
  /** The colleague list every enrolled principal may read. */
  directory: DirectoryResponse;
  /** The first roster page — null for a non-admin, who never fetches one. */
  initialPage: MembersResponse | null;
}

/**
 * The FG-26 **Users** screen.
 *
 * Two audiences, one route. Every enrolled principal sees the directory —
 * without it a member cannot address or delegate to anybody. Owners and admins
 * additionally get management: enrolment, roles, activation links, channel
 * mapping, CSV import and the audit trail. The split is enforced server-side on
 * every route (and again in Python); this component only decides what to draw.
 *
 * No password is generated, displayed, typed or relayed here. A new account is
 * created banned with a server-side random password and opened by a single-use
 * activation link that is shown exactly once — which is what removed the old
 * "copy this temporary password into a chat window" step.
 */
export function UsersView({
  role,
  userId,
  profile,
  administered = [],
  directory,
  initialPage,
}: UsersViewProps) {
  const scoped = (path: string) => withProfileQuery(path, profile);
  const router = useRouter();
  const { ask, dialog } = useConfirm();
  const undo = useUndoToast();
  const canManage = role === "owner" || role === "admin";
  const [page, setPage] = useState<MembersResponse | null>(initialPage);
  const [offset, setOffset] = useState(initialPage?.offset ?? 0);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  const [activeFilter, setActiveFilter] = useState<"" | "true" | "false">("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** A create/import that landed in a profile other than the one on screen. */
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const targets = administered.map((p) => p.name);
  const [link, setLink] = useState<
    { label: string; path: string; expiresAt?: string | null } | null
  >(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const members = page?.members ?? [];
  const total = page?.total ?? 0;

  async function load(next: {
    offset?: number;
    q?: string;
    role?: "" | Role;
    active?: "" | "true" | "false";
  }) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(next.offset ?? offset),
    });
    const q = next.q ?? query;
    const r = next.role ?? roleFilter;
    const a = next.active ?? activeFilter;
    if (q.trim()) params.set("q", q.trim());
    if (r) params.set("role", r);
    if (a) params.set("active", a);
    try {
      const res = await fetch(scoped(`/api/comms/members?${params.toString()}`), {
        cache: "no-store",
      });
      if (!res.ok) return;
      setPage((await res.json()) as MembersResponse);
    } catch {
      // A stale page is non-fatal; the next action re-reads.
    }
  }

  /** Run a mutation, then re-read the page it changed. */
  async function mutate(key: string, run: () => Promise<string | null>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    setElsewhere(null);
    try {
      const message = await run();
      if (message) setNotice(message);
      await load({});
    } catch (err) {
      setError(errorMessage(err, "The request was refused."));
    } finally {
      setBusy(null);
    }
  }

  async function createUser(input: {
    email: string;
    profile: string;
    display: string;
    role: Role;
  }) {
    await mutate("create", async () => {
      // The target goes in the query (the scope Python authorises in) and in
      // the body (what it compares with); the BFF refuses a mismatch.
      const target = input.profile;
      const resp = await sendJson<MemberCreateResponse>(
        withProfileQuery("/api/comms/members", target),
        "POST",
        { ...input, profile: target },
      );
      if (target !== profile) setElsewhere(target);
      if (resp.activation_path) {
        setLink({
          label: target === profile ? input.email : `${input.email} (${target})`,
          path: resp.activation_path,
          expiresAt: resp.invitation?.expires_at ?? null,
        });
        return null;
      }
      return resp.enrolled_existing
        ? `${input.email} already had an account on this box and is now enrolled in ${target} — ` +
            "their existing password still works, so there is no link to send."
        : `Enrolled ${resp.member.user_id} in ${target}.`;
    });
  }

  async function imported(target: string) {
    setElsewhere(target === profile ? null : target);
    await load({});
  }

  async function changeRole(member: Member, next: Role) {
    if (!page) return;
    if (ROLE_RANK[next] < ROLE_RANK[member.role]) {
      const ok = await ask({
        title: `Change ${member.display || member.user_id} to ${next}?`,
        body:
          member.user_id === userId
            ? `You will lose ${member.role} rights in ${profile} straight away, and may not be able to change this back yourself.`
            : `They lose what a ${member.role} can do in ${profile} as soon as you confirm.`,
        confirmLabel: `Yes, make ${next}`,
        tone: "danger",
      });
      if (!ok) return;
    }
    setBusy(member.user_id);
    setError(null);
    setNotice(null);
    // Shown immediately, undone if the server refuses (403, last-admin guard,
    // self-demotion) — see `optimisticRoleChange`.
    const failure = await optimisticRoleChange({
      page,
      userId: member.user_id,
      role: next,
      setPage,
      send: () =>
        sendJson(
          scoped(
            `/api/comms/members/${encodeURIComponent(member.user_id)}/role`
          ),
          "PUT",
          { role: next },
        ),
    });
    if (failure) {
      setError(failure);
    } else {
      setNotice(`${member.display || member.user_id} is now ${next}.`);
      await load({});
      // Demoting yourself changes what this screen may show you.
      if (member.user_id === userId) router.refresh();
    }
    setBusy(null);
  }

  /** A "Profiles & roles" change: re-read when it touched the viewed profile. */
  async function profilesChanged(changed: string, removedSelf: boolean) {
    if (changed !== profile) return;
    if (removedSelf) {
      router.push("/users");
      router.refresh();
      return;
    }
    await load({});
    router.refresh();
  }

  async function setEnrolled(member: Member, enrolled: boolean) {
    const name = member.display || member.user_id;
    if (!enrolled) {
      const ok = await ask({
        title: `Suspend ${name}?`,
        body: `They can no longer sign in to ${profile} until someone restores them. Their account and work are kept.`,
        confirmLabel: "Yes, suspend",
        tone: "danger",
      });
      if (!ok) return;
    }
    await sendEnrolled(member, enrolled);
    if (enrolled) undo.show(`${name} restored in ${profile}.`, () => sendEnrolled(member, false));
  }

  function sendEnrolled(member: Member, enrolled: boolean) {
    return mutate(member.user_id, async () => {
      await sendJson(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}` +
            (enrolled ? "/activate" : "/deactivate")
        ),
        "POST",
      );
      return `${member.display || member.user_id} ${
        enrolled ? "restored" : "suspended"
      } in ${profile}.`;
    });
  }

  function invite(member: Member) {
    return mutate(member.user_id, async () => {
      const resp = await sendJson<MemberInvitationResponse>(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}/invitation`
        ),
        "POST",
      );
      setLink({
        label: member.email || member.user_id,
        path: resp.activation_path,
        expiresAt: resp.invitation.expires_at,
      });
      return null;
    });
  }

  async function revokeInvite(member: Member) {
    const ok = await ask({
      title: `Revoke the link for ${member.display || member.user_id}?`,
      body: "The link stops working at once. You can send a new one later.",
      confirmLabel: "Yes, revoke",
      tone: "danger",
    });
    if (!ok) return;
    return mutate(member.user_id, async () => {
      await sendJson(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}/invitation`
        ),
        "DELETE",
      );
      return `Revoked the open link for ${member.display || member.user_id}.`;
    });
  }

  function rename(member: Member, display: string) {
    return mutate(member.user_id, async () => {
      await sendJson(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}/display`
        ),
        "PUT",
        { display },
      );
      return `Renamed to ${display}.`;
    });
  }

  function linkChannel(member: Member, platform: string, channelUserId: string) {
    return mutate(member.user_id, async () => {
      await sendJson(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}/channels`
        ),
        "POST",
        { platform, channel_user_id: channelUserId },
      );
      return `Linked ${platform}:${channelUserId}.`;
    });
  }

  async function remove(member: Member, strategy: "transfer" | "purge", transferTo: string) {
    setRemoving(null);
    await mutate(member.user_id, async () => {
      const params = new URLSearchParams({ strategy });
      if (transferTo) params.set("transfer_to", transferTo);
      await sendJson(
        scoped(
          `/api/comms/members/${encodeURIComponent(member.user_id)}?${params.toString()}`
        ),
        "DELETE",
      );
      return `Removed ${member.display || member.user_id} from ${profile}.`;
    });
    // Leaving the viewed profile: it is no longer yours to administer.
    if (member.user_id === userId) {
      router.push("/users");
      router.refresh();
    }
  }

  return (
    <div data-component="UsersView" className="flex flex-col gap-4">
      <AdminProfileSwitcher profiles={administered} current={profile} />
      <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
        <Pill tone="accent">{role}</Pill>
        {administered.length < 2 ? <Pill tone="muted">profile: {profile}</Pill> : null}
        {canManage ? <Pill tone="muted">{total} enrolled</Pill> : null}
      </p>

      {notice ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm">{notice}</p>
      ) : null}
      {elsewhere ? (
        <p
          data-component="CreatedElsewhere"
          role="status"
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
        >
          Created in <code>{elsewhere}</code> —{" "}
          <Link
            href={withProfileQuery("/users", elsewhere)}
            className="text-[var(--color-accent)] underline"
          >
            view
          </Link>
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      {link ? (
        <InvitationLink
          label={link.label}
          path={link.path}
          expiresAt={link.expiresAt}
          onDismiss={() => setLink(null)}
        />
      ) : null}

      <DirectoryPanel initial={directory} profile={profile} />

      {!canManage ? (
        <p
          data-component="UsersReadOnlyNotice"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Enrolling people, changing roles and issuing activation links are
          owner/admin actions. Ask an administrator of this profile.
        </p>
      ) : null}

      {canManage && page && !page.configured ? (
        <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          User management isn&apos;t configured on this server yet (it needs the
          Supabase GoTrue URL + service-role key set server-side).
        </p>
      ) : null}

      {canManage ? (
        <BusyRegion
          busy={busy !== null}
          label={busy === "create" ? "Enrolling…" : "Updating the user…"}
          className="flex flex-col gap-4"
        >
          <CreateUserForm
            profile={profile}
            profiles={targets}
            busy={busy === "create"}
            disabled={page ? !page.configured : false}
            onCreate={createUser}
          />

          <section
            data-component="UsersFilters"
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <input
              type="search"
              aria-label="Search users"
              placeholder="Search name or email"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
                void load({ q: e.target.value, offset: 0 });
              }}
              className="min-w-0 flex-1 basis-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm sm:basis-0"
            />
            <select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(e) => {
                const next = e.target.value as "" | Role;
                setRoleFilter(next);
                setOffset(0);
                void load({ role: next, offset: 0 });
              }}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-xs"
            >
              <option value="">every role</option>
              {(["owner", "admin", "member", "viewer"] as Role[]).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by enrolment"
              value={activeFilter}
              onChange={(e) => {
                const next = e.target.value as "" | "true" | "false";
                setActiveFilter(next);
                setOffset(0);
                void load({ active: next, offset: 0 });
              }}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-xs"
            >
              <option value="">any state</option>
              <option value="true">enrolled</option>
              <option value="false">suspended</option>
            </select>
          </section>

          <ul data-component="UsersList" className="flex flex-col gap-2">
            {members.map((member) => (
              <UserRow
                key={member.user_id}
                member={member}
                self={member.user_id === userId}
                canDelete={canManage}
                busy={busy === member.user_id}
                onChangeRole={changeRole}
                onSetEnrolled={setEnrolled}
                onInvite={invite}
                onRevokeInvite={revokeInvite}
                onRename={rename}
                onLinkChannel={linkChannel}
                onDelete={setRemoving}
                onProfilesChanged={profilesChanged}
              />
            ))}
            {members.length === 0 ? (
              <li className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
                No users match this view.
              </li>
            ) : null}
          </ul>

          <div
            data-component="UsersPager"
            className="flex items-center justify-between gap-2 text-xs text-[var(--color-muted)]"
          >
            <ActionButton
              disabled={offset === 0}
              onAction={() => {
                const next = Math.max(0, offset - PAGE_SIZE);
                setOffset(next);
                return load({ offset: next });
              }}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 disabled:opacity-50"
            >
              Previous
            </ActionButton>
            <span>
              {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`}{" "}
              of {total}
            </span>
            <ActionButton
              disabled={offset + PAGE_SIZE >= total}
              onAction={() => {
                const next = offset + PAGE_SIZE;
                setOffset(next);
                return load({ offset: next });
              }}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 disabled:opacity-50"
            >
              Next
            </ActionButton>
          </div>

          <CsvImportPanel profile={profile} profiles={targets} onApplied={imported} />
          <IdentityActivityPanel profile={profile} />
        </BusyRegion>
      ) : null}

      {removing ? (
        <RemoveUserDialog
          member={removing}
          profile={profile}
          self={removing.user_id === userId}
          candidates={members.filter((m) => m.user_id !== removing.user_id)}
          onCancel={() => setRemoving(null)}
          onConfirm={(strategy, transferTo) => remove(removing, strategy, transferTo)}
        />
      ) : null}
      {dialog}
      {undo.toast}
    </div>
  );
}
