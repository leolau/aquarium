"use client";

import { useState } from "react";

import { AuthIllustration } from "@/components/auth/AuthLayout";
import { authField, authHint, authLabel, authPrimary, authSecondary } from "@/components/auth/styles";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";
import type { SecretLinkInfo } from "@/types";

type Phase = "form" | "stored" | "declined" | "unusable";

function expiryTime(expiresAt: number): string {
  try {
    return new Date(expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** The neutral card for an unknown, used or expired link (one for all: no oracle). */
export function SecretLinkUnusable() {
  const t = useT("secretLink");
  return (
    <div data-component="SecretLinkUnusable" className="flex flex-col gap-3">
      <AuthIllustration name="lostFish" className="self-start" />
      <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("unusableTitle")}</h1>
      <p className="text-sm text-[var(--color-muted)]">{t("unusableBody")}</p>
    </div>
  );
}

/**
 * FG-37 masked secret entry behind a one-time link.
 *
 * The value lives only in this component's state: it is posted once to the
 * agent-home BFF, never logged, never put in browser storage, and the field is
 * cleared as soon as the request settles. Any refusal (used, expired, unknown)
 * shows the same neutral card.
 */
export function SecretLinkForm({ token, info }: { token: string; info: SecretLinkInfo }) {
  const t = useT("secretLink");
  const isPassword = info.kind === "password";
  const [username, setUsername] = useState(info.username ?? "");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"empty" | "network" | "invalid" | null>(null);
  const [phase, setPhase] = useState<Phase>("form");

  async function send(body: unknown): Promise<"stored" | "declined" | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/secret-links/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (res.ok) {
        const parsed = (await res.json()) as { status?: string };
        return parsed.status === "declined" ? "declined" : "stored";
      }
      if (res.status === 400) setError("invalid");
      else if (res.status === 404) setPhase("unusable");
      else setError("network");
      return null;
    } catch {
      setError("network");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    if (busy) return;
    if (!value.trim()) {
      setError("empty");
      return;
    }
    const values = isPassword
      ? { password: value, ...(username.trim() ? { username: username.trim() } : {}) }
      : { value };
    const outcome = await send({ values });
    setValue("");
    if (outcome) setPhase(outcome);
  }

  async function decline() {
    if (busy) return;
    setValue("");
    const outcome = await send({ decline: true });
    if (outcome) setPhase(outcome);
  }

  const { run: submitOnce } = useAction(submit);
  const { run: declineOnce } = useAction(decline);

  if (phase === "unusable") return <SecretLinkUnusable />;
  if (phase === "stored" || phase === "declined") {
    return (
      <div data-component="SecretLinkDone" data-phase={phase} className="flex flex-col gap-3" aria-live="polite">
        <AuthIllustration name="welcome" className="self-start" />
        <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">
          {t(phase === "stored" ? "storedTitle" : "declinedTitle")}
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          {t(phase === "stored" ? "storedBody" : "declinedBody")}
        </p>
      </div>
    );
  }

  const fieldLabel = isPassword ? t("password") : t("value");
  return (
    <form
      data-component="SecretLinkForm"
      onSubmit={(e) => void submitOnce(e)}
      aria-busy={busy}
      noValidate
      autoComplete="off"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{t("eyebrow")}</p>
        <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{info.label}</h1>
        {info.purpose ? <p className="text-sm text-[var(--color-muted)]">{info.purpose}</p> : null}
      </div>
      {error === "network" ? <InlineAlert tone="danger">{t("network")}</InlineAlert> : null}
      {error === "invalid" ? <InlineAlert tone="danger">{t("invalid")}</InlineAlert> : null}
      {isPassword ? (
        <label className={authLabel}>
          {t("username")}
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={authField}
          />
        </label>
      ) : null}
      <label className={authLabel}>
        {fieldLabel}
        <span className="flex gap-2">
          <input
            type={shown ? "text" : "password"}
            required
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-lpignore="true"
            aria-label={fieldLabel}
            aria-invalid={error === "empty"}
            aria-describedby="secret-link-hint"
            readOnly={busy}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`${authField} min-w-0 flex-1`}
          />
          <button
            type="button"
            data-action="secret-toggle"
            aria-pressed={shown}
            onClick={() => setShown((s) => !s)}
            className={authSecondary}
          >
            {shown ? t("hide") : t("show")}
          </button>
        </span>
        <span id="secret-link-hint" aria-live="polite" className={authHint}>
          {error === "empty" ? t("empty") : t("hint", { time: expiryTime(info.expires_at) })}
        </span>
      </label>
      <button type="submit" disabled={busy} className={`${authPrimary} w-full`}>
        {busy ? (
          <>
            <Spinner /> {t("saving")}
          </>
        ) : (
          t("save")
        )}
      </button>
      <button
        type="button"
        data-action="secret-decline"
        disabled={busy}
        onClick={() => void declineOnce()}
        className={`${authSecondary} w-full`}
      >
        {t("decline")}
      </button>
      <p className="text-xs text-[var(--color-muted)]">{t("privacy")}</p>
    </form>
  );
}
