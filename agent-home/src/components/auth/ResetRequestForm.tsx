"use client";

import { useState } from "react";

import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";

/**
 * "I can't sign in" — asks an administrator of the profile for a fresh link.
 *
 * The answer is always the same acknowledgement, whatever happened: "no such
 * account" and "not enrolled here" are precisely the enumeration oracle a
 * sign-in page must not offer. The link itself goes to an admin, never to
 * whoever filled in this box, so submitting somebody else's address achieves
 * nothing.
 */
export function ResetRequestForm() {
  const t = useT("login");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    setBusy(true);
    try {
      await fetch("/api/auth/invitations/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Even a transport failure must not distinguish addresses.
    } finally {
      setBusy(false);
      setSent(true);
      setEmail("");
    }
  }
  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: submitOnce } = useAction(submit);

  if (!open) {
    return (
      <button
        data-component="ResetRequestToggle"
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-[var(--color-muted)] underline"
      >
        {t("cantSignIn")}
      </button>
    );
  }

  return (
    <form
      data-component="ResetRequestForm"
      onSubmit={(e) => void submitOnce(e)}
      className="mt-4 flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <p className="text-xs text-[var(--color-muted)]">
        {t("resetIntro")}
      </p>
      <input
        type="email"
        required
        aria-label={t("resetEmailLabel")}
        placeholder="email@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs disabled:opacity-50"
      >
        {busy ? t("sending") : t("requestLink")}
      </button>
      {sent ? (
        <p className="text-xs text-[var(--color-muted)]">
          {t("resetSent")}
        </p>
      ) : null}
    </form>
  );
}
