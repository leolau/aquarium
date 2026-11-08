"use client";

import { useState } from "react";

import { authField, authLabel, authLink, authSecondary } from "@/components/auth/styles";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";

/**
 * "I can't sign in" — asks an administrator of the profile for a fresh link.
 *
 * The answer is always the same acknowledgement, whatever happened: "no such
 * account" and "not enrolled here" are precisely the enumeration oracle a
 * sign-in page must not offer. The link itself goes to an admin, never to
 * whoever filled in this box, so submitting somebody else's address achieves
 * nothing. `profile` (the sign-in page's `?profile=`) tells the server which
 * of the person's profiles the request should reach.
 */
export function ResetRequestForm({ profile }: { profile?: string } = {}) {
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
        body: JSON.stringify(profile ? { email, profile } : { email }),
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <button
          data-component="ResetRequestToggle"
          type="button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className={`${authLink} min-h-11 text-sm lg:min-h-0`}
        >
          {t("cantSignIn")}
        </button>
        <span className="text-[var(--color-muted)]">{t("noAccount")}</span>
      </div>
    );
  }

  return (
    <form
      data-component="ResetRequestForm"
      onSubmit={(e) => void submitOnce(e)}
      aria-busy={busy}
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
    >
      <h2 className="text-sm font-semibold">{t("cantSignIn")}</h2>
      <p className="text-xs text-[var(--color-muted)]">{t("resetIntro")}</p>
      <label className={authLabel}>
        {t("resetEmailLabel")}
        <input
          type="email"
          required
          autoComplete="email"
          readOnly={busy}
          placeholder="email@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={authField}
        />
      </label>
      <button type="submit" disabled={busy} className={authSecondary}>
        {busy ? (
          <>
            <Spinner /> {t("sending")}
          </>
        ) : (
          t("requestLink")
        )}
      </button>
      {sent ? <InlineAlert tone="info">{t("resetSent")}</InlineAlert> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(false);
          setSent(false);
        }}
        className={`${authLink} w-fit text-sm`}
      >
        {t("backToSignIn")}
      </button>
    </form>
  );
}
