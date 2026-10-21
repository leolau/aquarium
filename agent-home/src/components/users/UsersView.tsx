"use client";

import { useState } from "react";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill } from "@/components/ui/Pill";
import { CreateUserForm } from "@/components/users/CreateUserForm";
import { CsvImportPanel } from "@/components/users/CsvImportPanel";
import { DirectoryPanel } from "@/components/users/DirectoryPanel";
import { IdentityActivityPanel } from "@/components/users/IdentityActivityPanel";
import { InvitationLink } from "@/components/users/InvitationLink";
import { UserRow } from "@/components/users/UserRow";
import { PAGE_SIZE, errorMessage, sendJson } from "@/components/users/api";
import { optimisticRoleChange } from "@/components/users/optimistic";
import type {
  DirectoryResponse,
  Member,
  MemberCreateResponse,
  MemberInvitationResponse,
  MembersResponse,
  Role,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";


export interface UsersViewProps {
  /** The acting principal's role — decides which surfaces are even rendered. */
  role: Role;
  /** The acting principal, so its own row can protect itself. */
  userId: string;
  /** The profile this console administers (FG-27 derives its schema from it). */
  profile: string;
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
  directory,
  initialPage,
}: UsersViewProps) {
  const canManage = role === "owner" || role === "admin";
  const [page, setPage] = useState<MembersResponse | null>(initialPage);
  const [offset, setOffset] = useState(initialPage?.offset ?? 0);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  const [activeFilter, setActiveFilter] = useState<"" | "true" | "false">("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      const res = await fetch(`/api/comms/members?${params.toString()}`, {
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
      const resp = await sendJson<MemberCreateResponse>(
        "/api/comms/members",
        "POST",
        input,
      );
      if (resp.activation_path) {
        setLink({
          label: input.email,
          path: resp.activation_path,
          expiresAt: resp.invitation?.expires_at ?? null,
        });
        return null;
      }
      return resp.enrolled_existing
        ? `${input.email} already had an account on this box and is now enrolled — ` +
            "their existing password still works, so there is no link to send."
        : `Enrolled ${resp.member.user_id}.`;
    });
  }

  async function changeRole(member: Member, next: Role) {
    if (!page) return;
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
          `/api/comms/members/${encodeURIComponent(member.user_id)}/role`,
          "PUT",
          { role: next },
        ),
    });
    if (failure) {
      setError(failure);
    } else {
      setNotice(`${member.display || member.user_id} is now ${next}.`);
      await load({});
    }
    setBusy(null);
  }

  function setEnrolled(member: Member, enrolled: boolean) {
    return mutate(member.user_id, async () => {
      await sendJson(
        `/api/comms/members/${encodeURIComponent(member.user_id)}` +
          (enrolled ? "/activate" : "/deactivate"),
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
        `/api/comms/members/${encodeURIComponent(member.user_id)}/invitation`,
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

  function revokeInvite(member: Member) {
    return mutate(member.user_id, async () => {
      await sendJson(
        `/api/comms/members/${encodeURIComponent(member.user_id)}/invitation`,
        "DELETE",
      );
      return `Revoked the open link for ${member.display || member.user_id}.`;
    });
  }

  function rename(member: Member, display: string) {
    return mutate(member.user_id, async () => {
      await sendJson(
        `/api/comms/members/${encodeURIComponent(member.user_id)}/display`,
        "PUT",
        { display },
      );
      return `Renamed to ${display}.`;
    });
  }

  function linkChannel(member: Member, platform: string, channelUserId: string) {
    return mutate(member.user_id, async () => {
      await sendJson(
        `/api/comms/members/${encodeURIComponent(member.user_id)}/channels`,
        "POST",
        { platform, channel_user_id: channelUserId },
      );
      return `Linked ${platform}:${channelUserId}.`;
    });
  }

  function remove(member: Member, strategy: "transfer" | "purge", transferTo: string) {
    setRemoving(null);
    return mutate(member.user_id, async () => {
      const params = new URLSearchParams({ strategy });
      if (transferTo) params.set("transfer_to", transferTo);
      await sendJson(
        `/api/comms/members/${encodeURIComponent(member.user_id)}?${params.toString()}`,
        "DELETE",
      );
      return `Removed ${member.display || member.user_id} from ${profile}.`;
    });
  }

  return (
    <div data-component="UsersView" className="flex flex-col gap-4">
      <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
        <Pill tone="accent">{role}</Pill>
        <Pill tone="muted">profile: {profile}</Pill>
        {canManage ? <Pill tone="muted">{total} enrolled</Pill> : null}
      </p>

      {notice ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300">
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

      <DirectoryPanel initial={directory} />

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
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
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
                canDelete={role === "owner"}
                busy={busy === member.user_id}
                onChangeRole={changeRole}
                onSetEnrolled={setEnrolled}
                onInvite={invite}
                onRevokeInvite={revokeInvite}
                onRename={rename}
                onLinkChannel={linkChannel}
                onDelete={setRemoving}
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

          <CsvImportPanel profile={profile} />
          <IdentityActivityPanel />
        </BusyRegion>
      ) : null}

      {removing ? (
        <RemoveUserDialog
          member={removing}
          candidates={members.filter((m) => m.user_id !== removing.user_id)}
          onCancel={() => setRemoving(null)}
          onConfirm={remove}
        />
      ) : null}
    </div>
  );
}

/**
 * Removal asks what happens to the rows the user owns, because nothing else
 * will: deleting a principal does not cascade to their memories, files or GTS
 * items, and those rows would survive pointing at an `owner_user_id` that no
 * longer resolves — invisible under C2 and unreachable from any surface.
 */
function RemoveUserDialog({
  member,
  candidates,
  onCancel,
  onConfirm,
}: {
  member: Member;
  candidates: Member[];
  onCancel: () => void;
  onConfirm: (m: Member, strategy: "transfer" | "purge", transferTo: string) => unknown;
}) {
  const [strategy, setStrategy] = useState<"transfer" | "purge">("transfer");
  const [transferTo, setTransferTo] = useState(candidates[0]?.user_id ?? "");

  return (
    <div
      data-component="RemoveUserDialog"
      className="rounded-2xl border border-red-500/40 bg-[var(--color-surface)] p-4"
    >
      <p className="text-sm font-medium">
        Remove {member.display || member.email || member.user_id}?
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Their enrolment in this profile goes away. The box-wide account is kept —
        it may serve other profiles. Decide what happens to the memories, files
        and GTS items they own.
      </p>
      <label className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-[var(--color-muted)]">Owned rows</span>
        <select
          aria-label="Deletion strategy"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as "transfer" | "purge")}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
        >
          <option value="transfer">transfer to somebody</option>
          <option value="purge">purge the private ones</option>
        </select>
      </label>
      {strategy === "transfer" ? (
        <label className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">Inherited by</span>
          <select
            aria-label="Transfer owned rows to"
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            {candidates.map((c) => (
              <option key={c.user_id} value={c.user_id}>
                {c.display || c.user_id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-3 flex gap-2">
        <ActionButton
          disabled={strategy === "transfer" && !transferTo}
          onAction={() => onConfirm(member, strategy, strategy === "transfer" ? transferTo : "")}
          className="rounded-lg bg-red-500/20 px-3 py-1 text-xs text-red-200 disabled:opacity-50"
        >
          Remove
        </ActionButton>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
