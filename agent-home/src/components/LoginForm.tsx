"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authField, authLabel, authPrimary, authSecondary } from "@/components/auth/styles";
import { InlineAlert, type AlertTone } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { useAction } from "@/lib/use-action";

export interface ProviderOption {
  name: string;
  display_name: string;
  supports_password: boolean;
}

type IdKind = "email" | "username";

/**
 * Mobile-first login form for the C1 bridge. Submits credentials to the
 * `agent-home` `/api/session/login` route, which authenticates against the
 * Python `dashboard_auth` provider and mints the bridge session.
 *
 * The Email / Username tabs only change the field's label and autocomplete
 * hint; both send the same `username` value. Sign in locks on the first press
 * (Enter included) and, once it succeeds, stays locked until the next page
 * lands.
 */
export function LoginForm({
  providers,
  profile,
}: {
  providers: ProviderOption[];
  /** `/login?profile=`: the profile to land in, if the account is enrolled there. */
  profile?: string;
}) {
  const t = useT("login");
  const router = useRouter();
  const passwordProviders = providers.filter((p) => p.supports_password);
  const [provider, setProvider] = useState(passwordProviders[0]?.name ?? "");
  const [idKind, setIdKind] = useState<IdKind>("email");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ text: string; tone: AlertTone } | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Second step: this login has two-factor on. The password stays in memory
  // only until the code is accepted, then both are sent together.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const ta = useT("account");
  const locked = busy || leaving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locked) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          username,
          password,
          ...(needsCode ? { code } : {}),
          ...(profile ? { profile } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        detail?: string;
        error?: string;
        two_factor_required?: boolean;
        profile?: string;
      } | null;
      if (res.ok && body?.two_factor_required) {
        setNeedsCode(true);
        setCode("");
        return;
      }
      if (res.ok) {
        setLeaving(true);
        // Outside the default profile most pages still read only the default
        // one (FG-28 B4), so a login there lands in chat, which follows it.
        router.replace(body?.profile && body.profile !== "default" ? "/chat" : "/");
        router.refresh();
        return;
      }
      if (body?.error === "invalid_code") {
        setError({ text: ta("codeWrong"), tone: "danger" });
        return;
      }
      if (body?.error === "suspended") {
        setError({ text: t("suspended"), tone: "warn" });
        return;
      }
      if (body?.error === "no_principal") {
        setError({ text: t("noPrincipal"), tone: "info" });
        return;
      }
      if (body?.error === "too_many_attempts") {
        setError({ text: ta("tooMany"), tone: "danger" });
        return;
      }
      setError({ text: body?.detail ?? t("failed"), tone: "danger" });
    } catch {
      setError({ text: t("unreachable"), tone: "warn" });
    } finally {
      setBusy(false);
    }
  }
  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: submitOnce } = useAction(submit);

  const alert = error ? <InlineAlert tone={error.tone}>{error.text}</InlineAlert> : null;

  if (needsCode) {
    return (
      <form data-component="LoginCodeForm" onSubmit={(e) => void submitOnce(e)} aria-busy={locked} className="flex flex-col gap-4">
        {alert}
        <div>
          <h2 className="text-base font-semibold">{ta("loginCodeTitle")}</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{ta("loginCodeHelp")}</p>
        </div>
        <label className={authLabel}>
          {ta("loginCodeLabel")}
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            readOnly={locked}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${authField} font-mono tracking-[0.2em]`}
            required
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setNeedsCode(false);
              setPassword("");
              setError(null);
            }}
            className={authSecondary}
          >
            {ta("back")}
          </button>
          <button type="submit" disabled={locked || !code.trim()} className={`${authPrimary} flex-1`}>
            {locked ? (
              <>
                <Spinner size="md" />
                {ta("verifying")}
              </>
            ) : (
              ta("verify")
            )}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      data-component="LoginForm"
      onSubmit={(e) => void submitOnce(e)}
      aria-busy={locked}
      className="flex flex-col gap-4"
    >
      {alert}
      <div
        role="tablist"
        aria-label={t("signInWith")}
        className="inline-flex w-fit rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5"
      >
        {(["email", "username"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={idKind === kind}
            disabled={locked}
            onClick={() => setIdKind(kind)}
            className={`min-h-9 rounded-[var(--radius-full)] px-4 text-sm ${
              idKind === kind
                ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-text)]"
                : "text-[var(--color-muted)]"
            }`}
          >
            {t(kind === "email" ? "tabEmail" : "tabUsername")}
          </button>
        ))}
      </div>
      {passwordProviders.length > 1 ? (
        <label className={authLabel}>
          {t("provider")}
          <select
            value={provider}
            disabled={locked}
            onChange={(e) => setProvider(e.target.value)}
            className={authField}
          >
            {passwordProviders.map((p) => (
              <option key={p.name} value={p.name}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={authLabel}>
        {t(idKind === "email" ? "email" : "usernameOnly")}
        <input
          type={idKind === "email" ? "email" : "text"}
          autoComplete={idKind === "email" ? "email" : "username"}
          inputMode={idKind === "email" ? "email" : "text"}
          readOnly={locked}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={authField}
          required
        />
      </label>
      <label className={authLabel}>
        {t("password")}
        <input
          type="password"
          autoComplete="current-password"
          readOnly={locked}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={authField}
          required
        />
      </label>
      <button type="submit" disabled={locked || !provider} className={`${authPrimary} w-full`}>
        {locked ? (
          <>
            <Spinner size="md" />
            {t("signingIn")}
          </>
        ) : (
          t("signIn")
        )}
      </button>
      {passwordProviders.length === 0 ? (
        <InlineAlert tone="warn">{t("noProvider")}</InlineAlert>
      ) : null}
    </form>
  );
}
