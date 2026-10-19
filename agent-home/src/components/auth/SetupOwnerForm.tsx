"use client";

import { useEffect, useState } from "react";

import { errorMessage, sendJson } from "@/components/users/api";
import { useT, type Translator } from "@/i18n";

/** Mirrors the server-side minimum; the server is still the authority. */
const MIN_PASSWORD_LENGTH = 12;

export const SETUP_LINK_INVALID =
  "This setup link is not valid. It may have expired (links last 24 hours) or " +
  "been used already. Ask whoever installed Aquarium to run \"hermes setup-link\" " +
  "on the server for a new one.";

/** The one-time token from a `#token=…` fragment, or "" when there is none. */
export function tokenFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return (params.get("token") ?? "").trim();
}

/** Local checks before posting; ``null`` when the form looks fine. ``t`` is
 *  the "setup" translator; without it the messages are in English. */
export function setupFormError(
  email: string,
  password: string,
  confirm: string,
  t?: Translator,
): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return t ? t("errorEmail") : "Enter the owner's email address.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return t
      ? t("errorShort", { min: MIN_PASSWORD_LENGTH })
      : `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) {
    return t ? t("errorMismatch") : "The two passwords don't match.";
  }
  return null;
}

type Phase = "checking" | "invalid" | "form" | "done";

/**
 * First-run owner setup from the link `hermes setup-link` prints.
 *
 * The token is read from the URL fragment in the browser, then removed from the
 * address bar (so it is not left in history or on screen) and only ever posted
 * in a JSON body. It is never rendered into the page.
 */
export function SetupOwnerForm() {
  const t = useT("setup");
  const [phase, setPhase] = useState<Phase>("checking");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const found = tokenFromHash(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    const asked = found
      ? sendJson("/api/auth/setup/check", "POST", { token: found })
      : Promise.reject(new Error("no setup token in the link"));
    asked
      .then(() => {
        setToken(found);
        setPhase("form");
      })
      .catch(() => setPhase("invalid"));
    // A link pasted into a tab already on /setup only changes the fragment, which
    // does not reload the page; reload so the new token is read.
    const onHashChange = () => window.location.reload();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    if (busy) return;
    setError(null);
    const problem = setupFormError(email, password, confirm, t);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await sendJson("/api/auth/setup/owner", "POST", {
        token,
        email: email.trim(),
        password,
      });
      setPhase("done");
    } catch (err) {
      setError(errorMessage(err, t.has("invalidFull") ? t("invalidFull") : SETUP_LINK_INVALID));
    } finally {
      setBusy(false);
    }
  }

  const card =
    "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm";
  const field =
    "rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm";
  const button =
    "inline-block rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

  if (phase === "checking") {
    return (
      <p data-component="SetupChecking" aria-busy="true" className="text-sm text-[var(--color-muted)]">
        {t("checking")}
      </p>
    );
  }
  if (phase === "invalid") {
    return (
      <div data-component="SetupInvalid" role="alert" className={card}>
        <p>{t("invalid")}</p>
        <p className="mt-2 text-[var(--color-muted)]">
          {(() => {
            const [before, after = ""] = t("invalidHelp").split("{command}");
            return (
              <>
                {before}
                <code className="font-mono">hermes setup-link</code>
                {after}
              </>
            );
          })()}
        </p>
      </div>
    );
  }
  if (phase === "done") {
    return (
      <div data-component="SetupDone" className={card}>
        <p>{t("done")}</p>
        <a href="/login" className={`${button} mt-3`}>
          {t("signIn")}
        </a>
      </div>
    );
  }
  return (
    <form data-component="SetupOwnerForm" onSubmit={submit} aria-busy={busy} className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-muted)]">
        {t("intro", { min: MIN_PASSWORD_LENGTH })}
      </p>
      <input
        type="email"
        required
        autoComplete="email"
        aria-label={t("email")}
        placeholder={t("email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={field}
      />
      <input
        type="password"
        required
        autoComplete="new-password"
        aria-label={t("password")}
        placeholder={t("password")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={field}
      />
      <input
        type="password"
        required
        autoComplete="new-password"
        aria-label={t("confirm")}
        placeholder={t("confirm")}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className={field}
      />
      {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
      <button type="submit" disabled={busy} className={button}>
        {busy ? t("creating") : t("create")}
      </button>
    </form>
  );
}
