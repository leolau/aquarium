"use client";

import { useState } from "react";

import { AuthIllustration } from "@/components/auth/AuthLayout";
import { authField, authFieldError, authHint, authLabel, authLink, authPrimary } from "@/components/auth/styles";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { ForwardError, sendJson } from "@/components/users/api";
import { useT } from "@/i18n";
import { loginPathAfterActivation } from "@/lib/auth/activation-link";
import { useAction } from "@/lib/use-action";

/** Mirrors the server-side minimum; the server is still the authority. */
const MIN_PASSWORD_LENGTH = 12;

type Phase = "form" | "unusable" | "done";

/**
 * Set a first password from an invitation link.
 *
 * The token comes from the URL and is posted, never displayed or echoed back —
 * and the page it lives on is `noindex` with `Referrer-Policy: no-referrer`, so
 * it does not leak into a search index or into the next site's referrer header.
 *
 * Any refusal from the server shows the **same neutral card** ("This link
 * cannot be used") for an unknown, tampered, expired, already-used, revoked or
 * rate-limited token. Distinguishing them would turn this form into an oracle
 * for guessing valid tokens, so this component adds no diagnosis of its own
 * beyond the local length and match checks. Only a transport failure (the
 * server never answered) keeps the form, with a retryable alert.
 *
 * `profile` is the named profile from `/activate/<profile>/<token>`; it is
 * posted with the token (the server looks the token up only there) and the
 * "Sign in" step lands in it.
 */
export function ActivateForm({ token, profile }: { token: string; profile?: string }) {
  const t = useT("activate");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");

  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = password !== confirm;
  const loginHref = loginPathAfterActivation(profile);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    setSubmitted(true);
    setNetworkError(false);
    if (tooShort || mismatch) return;
    setBusy(true);
    try {
      await sendJson("/api/auth/invitations/redeem", "POST", {
        token,
        password,
        ...(profile ? { profile } : {}),
      });
      setPassword("");
      setConfirm("");
      setPhase("done");
    } catch (err) {
      if (err instanceof ForwardError) setPhase("unusable");
      else setNetworkError(true);
    } finally {
      setBusy(false);
    }
  }
  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: submitOnce } = useAction(submit);

  if (phase === "done") {
    return (
      <div data-component="ActivateDone" className="flex flex-col gap-4">
        <AuthIllustration name="welcome" className="self-start" />
        <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("doneTitle")}</h1>
        <InlineAlert tone="success">{t("done")}</InlineAlert>
        <a href={loginHref} className={`${authPrimary} w-full`}>
          {t("signIn")}
        </a>
      </div>
    );
  }

  if (phase === "unusable") {
    return (
      <div data-component="ActivateUnusable" className="flex flex-col gap-4">
        <AuthIllustration name="lostFish" className="self-start" />
        <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("unusableTitle")}</h1>
        <p className="text-sm text-[var(--color-muted)]">{t("unusableBody")}</p>
        <InlineAlert tone="info">{t("unusableWhy")}</InlineAlert>
        <a href={loginHref} className={`${authPrimary} w-full`}>
          {t("goToSignIn")}
        </a>
      </div>
    );
  }

  const showShort = submitted && tooShort;
  const showMismatch = submitted && !tooShort && mismatch;

  return (
    <form
      data-component="ActivateForm"
      onSubmit={(e) => void submitOnce(e)}
      aria-busy={busy}
      noValidate
      className="flex flex-col gap-4"
    >
      <AuthIllustration name="welcome" className="self-start" />
      <div className="flex flex-col gap-2">
        <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("title")}</h1>
        <p className="text-sm text-[var(--color-muted)]">{t("intro", { min: MIN_PASSWORD_LENGTH })}</p>
      </div>
      {networkError ? <InlineAlert tone="danger">{t("network")}</InlineAlert> : null}
      <label className={authLabel}>
        {t("newPassword")}
        <input
          type="password"
          required
          autoComplete="new-password"
          aria-label={t("newPassword")}
          aria-invalid={showShort}
          aria-describedby="activate-pw-hint"
          readOnly={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={authField}
        />
        <span id="activate-pw-hint" aria-live="polite" className={showShort ? authFieldError : authHint}>
          {showShort ? t("tooShort", { min: MIN_PASSWORD_LENGTH }) : t("hint", { min: MIN_PASSWORD_LENGTH })}
        </span>
      </label>
      <label className={authLabel}>
        {t("confirmPassword")}
        <input
          type="password"
          required
          autoComplete="new-password"
          aria-label={t("confirmPassword")}
          aria-invalid={showMismatch}
          aria-describedby="activate-confirm-hint"
          readOnly={busy}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={authField}
        />
        <span id="activate-confirm-hint" aria-live="polite">
          {showMismatch ? (
            <span className={authFieldError}>{t("mismatch")}</span>
          ) : confirm && !mismatch ? (
            <span className="text-xs font-normal text-[var(--color-success)]">{t("match")}</span>
          ) : null}
        </span>
      </label>
      <button type="submit" disabled={busy} className={`${authPrimary} w-full`}>
        {busy ? (
          <>
            <Spinner /> {t("setting")}
          </>
        ) : (
          t("setPassword")
        )}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        {t("alreadySet")}{" "}
        <a href={loginHref} className={authLink}>
          {t("signInInstead")}
        </a>
      </p>
    </form>
  );
}
