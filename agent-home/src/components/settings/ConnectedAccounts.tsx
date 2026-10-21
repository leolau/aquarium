"use client";

/**
 * Settings → Connected accounts: each login manages its own entries in the
 * unified credential store (docs/design/unified-credential-store.md).
 *
 * Connect flow is the skill's proven manual code-paste OAuth: ask for the
 * services to enable, open the consent URL, paste the code/redirect URL the
 * browser lands on. The response echoes the granted account + scopes so a
 * wrong-account consent on a shared browser is visible immediately.
 */
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { CredentialEntry, EmailPollerAccount } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

type ConnectPhase = "idle" | "consent" | "busy";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REDIRECT_URL_RE = /^https?:\/\/localhost:\d+/;
const BARE_CODE_RE = /^4\//;

/** Explain why a hint was rejected — the common mistake is pasting the
 *  step-3 redirect URL here, which re-runs start and clobbers the pending
 *  authorization. */
function hintError(hint: string): string | null {
  if (REDIRECT_URL_RE.test(hint) || hint.includes("code=")) {
    return "That looks like the redirect URL — it belongs in step 3, after you approve in Google.";
  }
  if (!EMAIL_RE.test(hint)) {
    return "Enter the Google account's email address, or leave it blank.";
  }
  return null;
}

/** The pasted value must be the localhost redirect URL or a bare code. */
function pastedError(pasted: string): string | null {
  if (REDIRECT_URL_RE.test(pasted) && pasted.includes("code=")) return null;
  if (BARE_CODE_RE.test(pasted)) return null;
  if (EMAIL_RE.test(pasted)) {
    return "That's the email-hint field's job — here paste the redirect URL the browser lands on after you approve.";
  }
  return "Paste the full redirect URL (starts with http://localhost:4321 and contains code=) or the bare code.";
}

const SERVICE_OPTIONS = [
  { id: "email", label: "Email (IMAP + Gmail API)" },
  { id: "calendar", label: "Calendar" },
  { id: "drive", label: "Drive" },
  { id: "workspace", label: "Full workspace (Drive, Docs, Sheets)" },
] as const;

/** Mirrors hermes_cli/google_oauth.SCOPES_BY_SERVICE — used to compare the
 *  stored `services` flags against the OAuth scopes actually granted, so the
 *  UI can flag "enabled but not consented" (e.g. a restored token that never
 *  had the mail scope). */
const SCOPES_BY_SERVICE: Record<string, string[]> = {
  email: ["https://mail.google.com/"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  drive: ["https://www.googleapis.com/auth/drive"],
  workspace: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
  ],
};

export function grantedScopes(entry: CredentialEntry): string[] {
  const scopes = entry.payload?.scopes;
  return Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
}

/** Whether the granted OAuth scopes cover every scope a service needs. */
export function serviceGranted(
  entry: CredentialEntry,
  service: string,
): boolean {
  const required = SCOPES_BY_SERVICE[service];
  if (!required) return true;
  const granted = new Set(grantedScopes(entry));
  return required.every((s) => granted.has(s));
}

export function ConnectedAccounts() {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [pollerAccounts, setPollerAccounts] = useState<
    Record<string, EmailPollerAccount>
  >({});
  const [pollerConfigPresent, setPollerConfigPresent] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<ConnectPhase>("idle");
  const [services, setServices] = useState<string[]>(["email", "calendar"]);
  const [hint, setHint] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [startedFor, setStartedFor] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<CredentialEntry | null>(
    null,
  );

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/credentials");
      if (res.ok) {
        const data = (await res.json()) as { credentials: CredentialEntry[] };
        setEntries(data.credentials);
        setError(null);
      } else {
        setError("Could not load connected accounts.");
      }
    } catch {
      setError("Could not load connected accounts.");
    }
    // The poller config is a deployment feature — a failed/absent endpoint
    // just hides the toggle, it doesn't error the section.
    try {
      const res = await fetch("/api/email-accounts");
      if (res.ok) {
        const data = (await res.json()) as {
          config_present: boolean;
          accounts: EmailPollerAccount[];
        };
        setPollerConfigPresent(data.config_present);
        setPollerAccounts(
          Object.fromEntries(
            data.accounts.map((a) => [a.address.toLowerCase(), a]),
          ),
        );
      }
    } catch {
      /* poller toggle stays hidden */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  const start = useCallback(async () => {
    const trimmedHint = hint.trim();
    if (trimmedHint) {
      const problem = hintError(trimmedHint);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setPhase("busy");
    setError(null);
    try {
      const res = await fetch("/api/credentials/google/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmedHint || undefined,
          services,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(data.detail ?? "Could not start the Google connection.");
        setPhase("idle");
        return;
      }
      const data = (await res.json()) as {
        auth_url: string;
        expires_in?: number;
      };
      setAuthUrl(data.auth_url);
      setExpiresIn(data.expires_in ?? null);
      setStartedFor(trimmedHint || null);
      setPasted("");
      setResult(null);
      setPhase("consent");
    } catch {
      setError("Could not start the Google connection.");
      setPhase("idle");
    }
  }, [hint, services]);

  const complete = useCallback(async () => {
    const problem = pastedError(pasted.trim());
    if (problem) {
      setError(problem);
      return;
    }
    setPhase("busy");
    setError(null);
    try {
      const res = await fetch("/api/credentials/google/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code_or_url: pasted.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        detail?: string;
        account_email?: string | null;
        granted_scopes?: string[];
      };
      if (res.status === 409) {
        // Pending state expired or was replaced — only a fresh start helps.
        setError("The sign-in link expired — start again below.");
        setPhase("idle");
        setAuthUrl(null);
        setExpiresIn(null);
        return;
      }
      if (!res.ok) {
        setError(data.detail ?? "Google rejected the code; try again.");
        setPhase("consent");
        return;
      }
      const hasMail = (data.granted_scopes ?? []).includes(
        "https://mail.google.com/",
      );
      const wrongAccount =
        startedFor &&
        data.account_email &&
        data.account_email.toLowerCase() !== startedFor.toLowerCase();
      setResult(
        `Connected ${data.account_email ?? "account"}` +
          (wrongAccount
            ? ` — note: Google approved a different account than the ${startedFor} hint`
            : "") +
          (hasMail ? "" : " — without the Mail scope, email polling stays off"),
      );
      setPhase("idle");
      setAuthUrl(null);
      setExpiresIn(null);
      setStartedFor(null);
      setPasted("");
      await reload();
    } catch {
      setError("Could not finish the Google connection.");
      setPhase("idle");
    }
  }, [pasted, startedFor, reload]);

  const toggleService = useCallback(
    async (entry: CredentialEntry, service: string, on: boolean) => {
      const next = on
        ? [...new Set([...entry.services, service])]
        : entry.services.filter((s) => s !== service);
      setEntries((prev) =>
        prev.map((e) =>
          e.provider === entry.provider && e.name === entry.name
            ? { ...e, services: next }
            : e,
        ),
      );
      const res = await fetch(
        `/api/credentials/${encodeURIComponent(entry.provider)}/${encodeURIComponent(entry.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ services: next }),
        },
      );
      if (!res.ok) setError("Could not update the account; reload to resync.");
    },
    [],
  );

  const toggleEmailPolling = useCallback(
    async (entry: CredentialEntry, on: boolean) => {
      const key = entry.name.toLowerCase();
      const previous = pollerAccounts[key];
      setPollerAccounts((prev) => ({
        ...prev,
        [key]: {
          id: previous?.id ?? "",
          address: entry.name,
          label: previous?.label ?? null,
          enabled: on,
        },
      }));
      const res = await fetch("/api/email-accounts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: entry.name, enabled: on }),
      });
      if (res.ok) {
        const data = (await res.json()) as { account: EmailPollerAccount };
        setPollerAccounts((prev) => ({ ...prev, [key]: data.account }));
      } else {
        setPollerAccounts((prev) => {
          const next = { ...prev };
          if (previous) next[key] = previous;
          else delete next[key];
          return next;
        });
        setError("Could not update email polling; reload to resync.");
      }
    },
    [pollerAccounts],
  );

  const setVisibility = useCallback(
    async (entry: CredentialEntry, visibility: string) => {
      const res = await fetch(
        `/api/credentials/${encodeURIComponent(entry.provider)}/${encodeURIComponent(entry.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visibility }),
        },
      );
      if (res.ok) {
        setEntries((prev) =>
          prev.map((e) =>
            e.provider === entry.provider && e.name === entry.name
              ? { ...e, visibility }
              : e,
          ),
        );
      } else {
        setError("Could not update the account; reload to resync.");
      }
    },
    [],
  );

  const disconnect = useCallback(
    async (entry: CredentialEntry) => {
      const res = await fetch(
        `/api/credentials/${encodeURIComponent(entry.provider)}/${encodeURIComponent(entry.name)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setEntries((prev) =>
          prev.filter(
            (e) => !(e.provider === entry.provider && e.name === entry.name),
          ),
        );
      } else {
        setError("Could not disconnect; reload to resync.");
      }
    },
    [],
  );

  return (
    <section id="connected-accounts" data-component="ConnectedAccounts">
      <h2 className="text-sm font-semibold">Connected accounts</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Your own Google (and other) credentials, stored per login. Background
        email/calendar polling uses an account only while its service toggle
        is on.
      </p>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {result && <p className="mb-2 text-xs text-green-400">{result}</p>}

      {loaded && entries.length === 0 && phase === "idle" && (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          Nothing connected yet for your login.
        </p>
      )}

      <ul className="mb-3 space-y-2">
        {entries.map((entry) => (
          <li
            key={`${entry.provider}/${entry.name}`}
            className="rounded border border-[var(--color-surface-2)] p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                {entry.name}{" "}
                <span className="font-normal text-[var(--color-muted)]">
                  ({entry.kind})
                </span>
              </span>
              <button
                type="button"
                className="text-xs text-red-400"
                onClick={() => setConfirmEntry(entry)}
              >
                Disconnect
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
              {SERVICE_OPTIONS.filter((s) => s.id !== "workspace").map((s) => {
                const flagged = entry.services.includes(s.id);
                const granted =
                  entry.provider !== "google" || serviceGranted(entry, s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-1"
                    title={
                      flagged && !granted
                        ? "Flag is set but the stored grant lacks this scope — reconnect to consent it."
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={flagged}
                      onChange={(e) =>
                        void toggleService(entry, s.id, e.target.checked)
                      }
                    />
                    {s.label}
                    {flagged && !granted && (
                      <span className="text-[var(--color-warn-text)]">(not granted)</span>
                    )}
                  </label>
                );
              })}
              {entry.provider === "google" && pollerConfigPresent && (
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={
                      pollerAccounts[entry.name.toLowerCase()]?.enabled ?? false
                    }
                    onChange={(e) =>
                      void toggleEmailPolling(entry, e.target.checked)
                    }
                  />
                  Email polling
                  {!entry.services.includes("email") ? (
                    <span className="text-[var(--color-muted)]">
                      (grant Email service too)
                    </span>
                  ) : (
                    !pollerAccounts[entry.name.toLowerCase()] && (
                      <span className="text-[var(--color-muted)]">
                        (adds a Gmail poller entry)
                      </span>
                    )
                  )}
                </label>
              )}
              <label className="flex items-center gap-1">
                <select
                  value={entry.visibility.startsWith("private") ? "private" : "shared"}
                  onChange={(e) =>
                    void setVisibility(
                      entry,
                      e.target.value === "shared"
                        ? "shared"
                        : `private:${entry.owner_user_id}`,
                    )
                  }
                  className="rounded border border-[var(--color-surface-2)] bg-transparent px-1 text-xs"
                >
                  <option value="private">private</option>
                  <option value="shared">shared</option>
                </select>
              </label>
            </div>
            {entry.provider === "google" && grantedScopes(entry).length > 0 && (
              <details className="mt-1 text-xs text-[var(--color-muted)]">
                <summary className="cursor-pointer">
                  {grantedScopes(entry).length} granted OAuth scopes
                </summary>
                <ul className="mt-1 list-inside list-disc break-all">
                  {grantedScopes(entry).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>

      {phase === "idle" && (
        <div className="space-y-2">
          <p className="text-xs font-semibold">1. Pick services &amp; start</p>
          <div className="flex flex-wrap gap-3 text-xs">
            {SERVICE_OPTIONS.map((s) => (
              <label key={s.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={services.includes(s.id)}
                  onChange={(e) =>
                    setServices((prev) =>
                      e.target.checked
                        ? [...prev, s.id]
                        : prev.filter((x) => x !== s.id),
                    )
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="Google account email (optional — pre-fills Google's sign-in)"
            className="w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1 text-xs"
          />
          <ActionButton busyLabel="Connecting…"
            disabled={services.length === 0}
            onAction={() => start()}
            className="rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-black"
          >
            Connect Google account
          </ActionButton>
        </div>
      )}

      {phase !== "idle" && authUrl && (
        <div className="space-y-3 text-xs">
          <div className="space-y-1">
            <p className="font-semibold">2. Approve in Google</p>
            <p>
              <a
                href={authUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded bg-[var(--color-accent)] px-2 py-1 font-semibold text-black"
              >
                Open Google sign-in
              </a>
            </p>
            <p className="text-[var(--color-muted)]">
              Google shows an account chooser — pick the account to connect
              {startedFor ? ` (expecting ${startedFor})` : ""} and approve
              every checked service.
              {expiresIn
                ? ` Link expires in about ${Math.round(expiresIn / 60)} minutes.`
                : ""}
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold">3. Paste the redirect URL</p>
            <p className="text-[var(--color-muted)]">
              After approving, the browser lands on a localhost page that says
              it can&apos;t be reached — that&apos;s expected. Copy the
              address-bar URL here:
            </p>
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="http://localhost:4321/?code=…&state=…"
              className="w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1"
            />
            <div className="flex gap-2">
              <ActionButton
                disabled={phase === "busy" || !pasted.trim()}
                onAction={() => complete()}
                className="rounded bg-[var(--color-accent)] px-2 py-1 font-semibold text-black"
              >
                {phase === "busy" ? "Working…" : "Complete"}
              </ActionButton>
              <button
                type="button"
                disabled={phase === "busy"}
                onClick={() => {
                  setPhase("idle");
                  setAuthUrl(null);
                  setExpiresIn(null);
                  setStartedFor(null);
                }}
                className="rounded px-2 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === "busy" && !authUrl && (
        <p className="text-xs text-[var(--color-muted)]">Working…</p>
      )}

      {confirmEntry && (
        <ConfirmDialog
          title="Disconnect account?"
          body={`Disconnect ${confirmEntry.name}? Its stored credential is removed — services using it (email, calendar, Drive) stop working until you connect it again.`}
          confirmLabel="Disconnect"
          onCancel={() => setConfirmEntry(null)}
          onConfirm={() => {
            const entry = confirmEntry;
            setConfirmEntry(null);
            return disconnect(entry);
          }}
        />
      )}
    </section>
  );
}
