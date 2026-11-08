"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ASSIGNABLE_ROLES } from "@/components/users/CreateUserForm";
import {
  RemoveUserDialog,
  type RemovalCandidate,
} from "@/components/users/RemoveUserDialog";
import { errorMessage, sendJson } from "@/components/users/api";
import { withProfileQuery } from "@/lib/profile";
import type {
  Member,
  MembersResponse,
  PersonProfile,
  PersonProfilesResponse,
  Role,
} from "@/types";

/** The person's enrolments in the profiles the caller administers. */
async function fetchPersonProfiles(userId: string): Promise<PersonProfile[]> {
  const res = await fetch(
    `/api/comms/people/${encodeURIComponent(userId)}/profiles`,
    { cache: "no-store" },
  );
  const body = (await res.json()) as PersonProfilesResponse & { detail?: string };
  if (!res.ok) throw new Error(body.detail ?? "Couldn't load profiles.");
  return body.profiles ?? [];
}

/**
 * One person's enrolment across the profiles the acting admin administers:
 * one line per profile with their role and state there (or "not enrolled"),
 * and Add / Change role / Remove.
 *
 * The list comes from `GET /api/comms/people/{id}/profiles`, which names only
 * profiles where the caller is an active owner or admin — so this panel never
 * learns, let alone shows, whether the person is enrolled anywhere else. Each
 * action goes to the existing members routes with `?profile=<that profile>`,
 * where the BFF and Python re-check the caller's role in that profile.
 */
export function ProfileRolesPanel({
  member,
  self,
  onChanged,
}: {
  member: Pick<Member, "user_id" | "display" | "email">;
  /** The acting person is looking at their own enrolments. */
  self: boolean;
  /** A change landed in `profile`; `removedSelf` when the actor left it. */
  onChanged?: (profile: string, removedSelf: boolean) => unknown;
}) {
  const id = member.user_id;
  const name = member.display || member.email || id;
  const [rows, setRows] = useState<PersonProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addRole, setAddRole] = useState<Record<string, Role>>({});
  const [removing, setRemoving] = useState<
    { profile: string; candidates: RemovalCandidate[] } | null
  >(null);

  async function load() {
    try {
      setRows(await fetchPersonProfiles(id));
    } catch (err) {
      setError(errorMessage(err, "Couldn't load profiles."));
      setRows((prev) => prev ?? []);
    }
  }

  useEffect(() => {
    let live = true;
    fetchPersonProfiles(id).then(
      (profiles) => {
        if (live) setRows(profiles);
      },
      (err: unknown) => {
        if (!live) return;
        setError(errorMessage(err, "Couldn't load profiles."));
        setRows([]);
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  async function act(
    profile: string,
    run: () => Promise<string>,
    removedSelf = false,
  ) {
    setBusy(profile);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      await load();
      await onChanged?.(profile, removedSelf);
    } catch (err) {
      setError(errorMessage(err, "The request was refused."));
    } finally {
      setBusy(null);
    }
  }

  function add(profile: string) {
    const role = addRole[profile] ?? "member";
    return act(profile, async () => {
      await sendJson(withProfileQuery("/api/comms/members", profile), "POST", {
        email: member.email,
        profile,
        display: member.display,
        role,
      });
      return `Added ${name} to ${profile} as ${role}.`;
    });
  }

  function changeRole(profile: string, role: Role) {
    return act(profile, async () => {
      await sendJson(
        withProfileQuery(`/api/comms/members/${encodeURIComponent(id)}/role`, profile),
        "PUT",
        { role },
      );
      return `${name} is now ${role} in ${profile}.`;
    });
  }

  async function openRemove(profile: string) {
    setError(null);
    try {
      const res = await fetch(
        withProfileQuery("/api/comms/members?limit=200", profile),
        { cache: "no-store" },
      );
      const page = (await res.json()) as MembersResponse & { detail?: string };
      if (!res.ok) throw new Error(page.detail ?? "Couldn't load that profile's roster.");
      setRemoving({
        profile,
        candidates: (page.members ?? []).filter((m) => m.user_id !== id),
      });
    } catch (err) {
      setError(errorMessage(err, "Couldn't load that profile's roster."));
    }
  }

  function remove(profile: string, strategy: "transfer" | "purge", transferTo: string) {
    setRemoving(null);
    return act(
      profile,
      async () => {
        const params = new URLSearchParams({ strategy });
        if (transferTo) params.set("transfer_to", transferTo);
        await sendJson(
          withProfileQuery(
            `/api/comms/members/${encodeURIComponent(id)}?${params.toString()}`,
            profile,
          ),
          "DELETE",
        );
        return `Removed ${name} from ${profile}.`;
      },
      self,
    );
  }

  return (
    <section
      data-component="ProfileRolesPanel"
      aria-label={`Profiles and roles for ${name}`}
      className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3"
    >
      <p className="text-xs font-medium">Profiles &amp; roles</p>
      <p className="text-xs text-[var(--color-muted)]">
        Only profiles you administer are listed.
      </p>
      {notice ? (
        <p role="status" className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {rows === null ? (
        <p className="text-xs text-[var(--color-muted)]">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.name}
              data-component="ProfileRoleLine"
              data-profile={row.name}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs"
            >
              <code className="min-w-0 flex-1 truncate">{row.name}</code>
              {!row.enrolled ? (
                <>
                  <span className="text-[var(--color-muted)]">not enrolled</span>
                  <select
                    aria-label={`Role to add in ${row.name}`}
                    value={addRole[row.name] ?? "member"}
                    disabled={busy !== null}
                    onChange={(e) =>
                      setAddRole({ ...addRole, [row.name]: e.target.value as Role })
                    }
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <ActionButton
                    disabled={busy !== null || !member.email}
                    title={member.email ? undefined : "This person has no email to enrol by."}
                    onAction={() => add(row.name)}
                    className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent-fg)] disabled:opacity-50"
                  >
                    Add
                  </ActionButton>
                </>
              ) : row.is_owner ? (
                <span className="text-[var(--color-muted)]">
                  owner — managed via <code>hermes owner transfer</code>
                </span>
              ) : (
                <>
                  {row.active === false ? (
                    <span className="text-[var(--color-warn-text)]">suspended</span>
                  ) : null}
                  <select
                    aria-label={`Role in ${row.name}`}
                    value={row.role ?? "member"}
                    disabled={busy !== null}
                    onChange={(e) => void changeRole(row.name, e.target.value as Role)}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <ActionButton
                    disabled={busy !== null}
                    onAction={() => openRemove(row.name)}
                    className="rounded-lg bg-[var(--color-danger)]/15 px-3 py-1 text-xs text-[var(--color-danger)] disabled:opacity-50"
                  >
                    Remove…
                  </ActionButton>
                </>
              )}
            </li>
          ))}
          {rows.length === 0 ? (
            <li className="text-xs text-[var(--color-muted)]">
              You don&apos;t administer any profile.
            </li>
          ) : null}
        </ul>
      )}
      {removing ? (
        <RemoveUserDialog
          member={member}
          profile={removing.profile}
          self={self}
          candidates={removing.candidates}
          onCancel={() => setRemoving(null)}
          onConfirm={(strategy, transferTo) => remove(removing.profile, strategy, transferTo)}
        />
      ) : null}
    </section>
  );
}
