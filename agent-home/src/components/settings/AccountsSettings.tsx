"use client";

import { useEffect, useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import {
  ACCOUNT_SURFACES,
  automaticOwner,
  type AccountPerson,
  type AccountRow,
  type AccountsState,
} from "@/lib/accounts";

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function putOwner(row: AccountRow, ownerUserId: string | null): Promise<AccountsState> {
  const res = await fetch("/api/settings/accounts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surface: row.surface, account: row.account, owner_user_id: ownerUserId }),
  });
  if (!res.ok) throw new Error(await detailOf(res));
  return (await res.json()) as AccountsState;
}

const SELECT =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm sm:w-64";

function AccountItem({
  row,
  people,
  onSaved,
}: {
  row: AccountRow;
  people: AccountPerson[];
  onSaved: (state: AccountsState) => void;
}) {
  const t = useT("settings");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const byId = new Map(people.map((p) => [p.user_id, p]));
  const nameOf = (id: string | null) => (id ? (byId.get(id)?.display ?? id) : "?");
  const installOwner = people.find((p) => p.role === "owner" && p.active)?.user_id ?? null;
  const fallback = automaticOwner(row) ?? installOwner;
  const owner = row.owner_user_id ? byId.get(row.owner_user_id) : undefined;
  const choices = people.filter((p) => p.active || p.user_id === row.settings_owner);

  async function choose(value: string) {
    const next = value === "" ? null : value;
    setPending(true);
    setError(null);
    setSaved(null);
    try {
      onSaved(await putOwner(row, next));
      setSaved(t("accounts.saved", { name: nameOf(next ?? fallback) }));
    } catch (err) {
      setError(t("accounts.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      data-component="AccountItem"
      data-account={`${row.surface}:${row.account}`}
      className="flex flex-col gap-2 border-b border-[var(--color-border)] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {row.label}
          {row.enabled ? null : (
            <span className="ml-2 text-xs text-[var(--color-muted)]">{t("accounts.off")}</span>
          )}
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          {nameOf(row.owner_user_id)} · {t(`accounts.source.${row.source}`)}
        </p>
        {owner && !owner.active ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {t("accounts.inactive", { name: owner.display })}
          </p>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span className="sr-only">{t("accounts.person")}</span>
        <select
          className={SELECT}
          value={row.settings_owner ?? ""}
          disabled={pending}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">{t("accounts.automatic", { name: nameOf(fallback) })}</option>
          {choices.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.display}
            </option>
          ))}
        </select>
        {pending ? <Spinner /> : null}
      </label>
      {error ? (
        <p role="alert" className="w-full text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="w-full text-xs text-[var(--color-success)]">
          {saved}
        </p>
      ) : null}
    </li>
  );
}

/** Settings › Accounts (owner only): whose each mailbox, calendar and WhatsApp phone is. */
export function AccountsSettings() {
  const t = useT("settings");
  const [state, setState] = useState<AccountsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/settings/accounts", { cache: "no-store", signal: ac.signal });
        if (!res.ok) throw new Error(await detailOf(res));
        const body = (await res.json()) as AccountsState;
        if (!ac.signal.aborted) setState(body);
      } catch (err) {
        if (!ac.signal.aborted) setLoadError(err instanceof Error ? err.message : "?");
      }
    })();
    return () => ac.abort();
  }, []);

  if (loadError) {
    return (
      <p data-component="AccountsSettings" role="alert" className="text-sm text-[var(--color-danger)]">
        {t("accounts.loadFailed", { error: loadError })}
      </p>
    );
  }
  if (!state) return <Spinner />;

  return (
    <div data-component="AccountsSettings" data-section="accounts" className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-muted)]">{t("accounts.intro")}</p>
      {state.unreadable.length > 0 ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {t("accounts.unreadable", { sources: state.unreadable.join(", ") })}
        </p>
      ) : null}
      {state.accounts.length === 0 ? <p className="text-sm">{t("accounts.empty")}</p> : null}
      {ACCOUNT_SURFACES.map((surface) => {
        const rows = state.accounts.filter((a) => a.surface === surface);
        if (rows.length === 0) return null;
        return (
          <section key={surface} className="rounded-xl border border-[var(--color-border)] p-4">
            <h2 className="mb-1 text-sm font-semibold">{t(`accounts.surface.${surface}`)}</h2>
            <ul>
              {rows.map((row) => (
                <AccountItem key={row.account} row={row} people={state.people} onSaved={setState} />
              ))}
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-[var(--color-muted)]">{t("accounts.personal")}</p>
    </div>
  );
}
