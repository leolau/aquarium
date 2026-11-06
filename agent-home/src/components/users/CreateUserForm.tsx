"use client";

import { type FormEvent, useState } from "react";

import type { Role } from "@/types";
import { useAction } from "@/lib/use-action";

/** Roles assignable here — never `owner` (ownership moves via the CLI). */
export const ASSIGNABLE_ROLES: readonly Role[] = ["admin", "member", "viewer"] as const;

/**
 * Enrol somebody into a profile.
 *
 * There is deliberately **no password field**: the server creates the account
 * banned with a random password and returns a single-use activation link, so an
 * admin never learns (and never has to relay) a credential. `profile` is
 * required and is sent as typed — a foreign value is refused with 409 before any
 * account is created, rather than being quietly rewritten to this profile.
 *
 * An email that already has an account is the *normal* case when somebody joins
 * a second profile: it enrols them and mints no link, because they already have
 * a password.
 *
 * FG-28 C4: the target is picked from `profiles`, the caller's administered
 * profiles, and starts on the one being viewed. The picker is a routing hint,
 * never a grant: Python re-derives the caller's role in the target.
 */
export function CreateUserForm({
  profile,
  profiles = [],
  busy,
  disabled,
  onCreate,
}: {
  /** The profile being viewed — the target until another is picked. */
  profile: string;
  /** The profiles the caller administers; a picker appears for two or more. */
  profiles?: string[];
  busy: boolean;
  disabled: boolean;
  onCreate: (input: {
    email: string;
    profile: string;
    display: string;
    role: Role;
  }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [display, setDisplay] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [target, setTarget] = useState(profile);
  const options = targetOptions(profile, profiles);

  async function submit(evt: FormEvent) {
    evt.preventDefault();
    await onCreate({ email: email.trim(), profile: target, display, role });
    setEmail("");
    setDisplay("");
    setRole("member");
  }

  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: submitOnce } = useAction(submit);

  return (
    <form
      data-component="CreateUserForm"
      onSubmit={(evt) => void submitOnce(evt)}
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <p className="text-sm font-medium">Add a user</p>
      <input
        type="email"
        required
        aria-label="Email address"
        placeholder="email@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />
      <input
        type="text"
        aria-label="Display name"
        placeholder="Display name (optional)"
        value={display}
        onChange={(e) => setDisplay(e.target.value)}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-[var(--color-muted)]">Role</span>
        <select
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        >
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {options.length > 1 ? (
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-[var(--color-muted)]">Profile</span>
          <select
            required
            name="profile"
            aria-label="Profile"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">
        {options.length > 1 ? null : (
          <>
            Creating in <code>{target}</code>.{" "}
          </>
        )}
        New accounts start locked and are opened by the activation link this
        returns; somebody who already has an account keeps their password.
      </p>
      <button
        type="submit"
        disabled={busy || disabled}
        className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create user"}
      </button>
    </form>
  );
}

/**
 * The profiles the form may target: the administered ones, the viewed one
 * first if the list somehow lacks it (Python still decides either way).
 */
export function targetOptions(profile: string, profiles: string[]): string[] {
  return profiles.includes(profile) ? profiles : [profile, ...profiles];
}
