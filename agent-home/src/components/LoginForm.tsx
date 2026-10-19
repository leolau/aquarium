"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";

export interface ProviderOption {
  name: string;
  display_name: string;
  supports_password: boolean;
}

/**
 * Mobile-first login form for the C1 bridge. Submits credentials to the
 * `agent-home` `/api/session/login` route, which authenticates against the
 * Python `dashboard_auth` provider and mints the bridge session.
 */
export function LoginForm({ providers }: { providers: ProviderOption[] }) {
  const t = useT("login");
  const router = useRouter();
  const passwordProviders = providers.filter((p) => p.supports_password);
  const [provider, setProvider] = useState(passwordProviders[0]?.name ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Second step: this login has two-factor on. The password stays in memory
  // only until the code is accepted, then both are sent together.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const ta = useT("account");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          needsCode ? { provider, username, password, code } : { provider, username, password },
        ),
      });
      const body = (await res.json().catch(() => null)) as {
        detail?: string;
        error?: string;
        two_factor_required?: boolean;
      } | null;
      if (res.ok && body?.two_factor_required) {
        setNeedsCode(true);
        setCode("");
        return;
      }
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      if (body?.error === "invalid_code") {
        setError(ta("codeWrong"));
        return;
      }
      if (body?.error === "too_many_attempts") {
        setError(ta("tooMany"));
        return;
      }
      setError(body?.detail ?? t("failed"));
    } catch {
      setError(t("unreachable"));
    } finally {
      setBusy(false);
    }
  }

  if (needsCode) {
    return (
      <form data-component="LoginCodeForm" onSubmit={submit} aria-busy={busy} className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">{ta("loginCodeTitle")}</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{ta("loginCodeHelp")}</p>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--color-muted)]">{ta("loginCodeLabel")}</span>
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 font-mono tracking-[0.2em]"
            required
          />
        </label>
        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-3 font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {busy ? (
            <>
              <Spinner size="md" />
              {ta("verifying")}
            </>
          ) : (
            ta("verify")
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setNeedsCode(false);
            setPassword("");
            setError(null);
          }}
          className="w-full text-sm text-[var(--color-muted)] underline"
        >
          {ta("back")}
        </button>
      </form>
    );
  }

  return (
    // The form stays interactive while the credentials are checked — `busy`
    // disables submit, and a user who mistyped their password should be able to
    // fix the field rather than wait behind an overlay.
    <form
      data-component="LoginForm"
      onSubmit={submit}
      aria-busy={busy}
      className="space-y-4"
    >
      {passwordProviders.length > 1 ? (
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--color-muted)]">{t("provider")}</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3"
          >
            {passwordProviders.map((p) => (
              <option key={p.name} value={p.name}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block text-sm">
        <span className="mb-1 block text-[var(--color-muted)]">{t("username")}</span>
        <input
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3"
          required
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-[var(--color-muted)]">{t("password")}</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3"
          required
        />
      </label>
      {error ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || !provider}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-3 font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
      >
        {busy ? (
          <>
            <Spinner size="md" />
            {t("signingIn")}
          </>
        ) : (
          t("signIn")
        )}
      </button>
      {passwordProviders.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          {t("noProvider")}
        </p>
      ) : null}
    </form>
  );
}
