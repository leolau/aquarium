"use client";

import { useState } from "react";

import { errorMessage, sendJson } from "@/components/users/api";
import { useAction } from "@/lib/use-action";

/** Mirrors the server-side minimum; the server is still the authority. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Set a first password from an invitation link.
 *
 * The token comes from the URL and is posted, never displayed or echoed back —
 * and the page it lives on is `noindex` with `Referrer-Policy: no-referrer`, so
 * it does not leak into a search index or into the next site's referrer header.
 *
 * On failure the message is whatever the server said, which is deliberately the
 * **same neutral sentence** for an unknown, tampered, expired, already-used,
 * revoked or rate-limited token. Distinguishing them would turn this form into
 * an oracle for guessing valid tokens, so this component adds no diagnosis of
 * its own beyond the local length check.
 */
export function ActivateForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await sendJson("/api/auth/invitations/redeem", "POST", { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "This link cannot be used."));
    } finally {
      setBusy(false);
    }
  }
  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: submitOnce } = useAction(submit);

  if (done) {
    return (
      <div
        data-component="ActivateDone"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
      >
        <p>Your password is set and your account is open.</p>
        <a
          href="/login"
          className="mt-3 inline-block rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          Sign in
        </a>
      </div>
    );
  }

  return (
    <form
      data-component="ActivateForm"
      onSubmit={(e) => void submitOnce(e)}
      aria-busy={busy}
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-[var(--color-muted)]">
        Choose a password of at least {MIN_PASSWORD_LENGTH} characters. This link
        works once and expires quickly — if it has, ask an administrator of your
        profile for a new one.
      </p>
      <input
        type="password"
        required
        autoComplete="new-password"
        aria-label="New password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />
      <input
        type="password"
        required
        autoComplete="new-password"
        aria-label="Confirm password"
        placeholder="Confirm password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
      >
        {busy ? "Setting…" : "Set password"}
      </button>
    </form>
  );
}
