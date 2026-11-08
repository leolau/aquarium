"use client";

/**
 * Settings → In&Out → SQL Server databases: the signed-in person's own SQL
 * Server connections. Saved in the credential store as `mssql` entries
 * private to that person; Hermes `/api/mssql/connections` never returns the
 * password. "Save and test" saves, then signs in (through the chosen VPN)
 * and reads the server version. Only the owner sees "Allow changes"; the
 * `mssql_query` tool asks before every change even then.
 */
import { useCallback, useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/i18n/client";
import { useAction } from "@/lib/use-action";
import type {
  MssqlConnection,
  MssqlConnectionInput,
  MssqlEncrypt,
  VpnView,
} from "@/types";

type T = ReturnType<typeof useT>;

export interface SqlFormValues {
  name: string;
  host: string;
  port: string;
  instance: string;
  database: string;
  username: string;
  password: string;
  encrypt: MssqlEncrypt;
  trust_server_certificate: boolean;
  legacy_tls: boolean;
  vpn: string;
  allow_writes: boolean;
}

const EMPTY: SqlFormValues = {
  name: "", host: "", port: "1433", instance: "", database: "", username: "", password: "",
  encrypt: "on", trust_server_certificate: false, legacy_tls: false, vpn: "", allow_writes: false,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function fromConnection(c: MssqlConnection): SqlFormValues {
  return {
    name: c.name, host: c.host, port: c.port == null ? "" : String(c.port), instance: c.instance,
    database: c.database, username: c.username, password: "", encrypt: c.encrypt,
    trust_server_certificate: c.trust_server_certificate, legacy_tls: c.legacy_tls,
    vpn: c.vpn, allow_writes: c.allow_writes,
  };
}

/** Form → request body, or the message key of the problem to show. */
export function toSqlInput(
  v: SqlFormValues,
  editing: boolean,
  isOwner: boolean,
): { body: MssqlConnectionInput } | { problem: string } {
  if ([v.name, v.host, v.database, v.username].some((x) => !x.trim())) return { problem: "errRequired" };
  if (!NAME_RE.test(v.name.trim())) return { problem: "errName" };
  let port: number | null = null;
  if (v.port.trim()) {
    port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: "errPort" };
  } else if (!v.instance.trim()) {
    return { problem: "errPort" };
  }
  if (!editing && !v.password) return { problem: "errPassword" };
  return {
    body: {
      host: v.host.trim(),
      port,
      instance: v.instance.trim(),
      database: v.database.trim(),
      username: v.username.trim(),
      ...(v.password ? { password: v.password } : {}),
      encrypt: v.encrypt,
      trust_server_certificate: v.encrypt === "strict" ? false : v.trust_server_certificate,
      legacy_tls: v.legacy_tls,
      vpn: v.vpn,
      ...(isOwner ? { allow_writes: v.allow_writes } : {}),
    },
  };
}

const inputCls =
  "w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1 text-xs";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";
const checkCls = "flex items-center gap-1 text-xs text-[var(--color-muted)]";
const btnCls =
  "rounded border border-[var(--color-surface-2)] px-2 py-1 text-xs font-semibold disabled:opacity-50";
const primaryBtnCls =
  "rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50";

const STATE_KEY: Record<MssqlConnection["state"], string> = {
  working: "stateWorking",
  needs_attention: "stateNeedsAttention",
  untested: "stateUntested",
};
const STATE_COLOR: Record<MssqlConnection["state"], string> = {
  working: "text-[var(--color-accent)]",
  needs_attention: "text-[var(--color-danger)]",
  untested: "text-[var(--color-muted)]",
};

async function readError(res: Response): Promise<string> {
  try {
    const doc = (await res.json()) as { detail?: string; error?: string };
    return doc.detail || doc.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

const path = (name: string) => `/api/mssql/connections/${encodeURIComponent(name)}`;

export function SqlServerConnections({ isOwner = false }: { isOwner?: boolean }) {
  const t = useT("mssql");
  const [connections, setConnections] = useState<MssqlConnection[] | null>(null);
  const [driverAvailable, setDriverAvailable] = useState(true);
  const [vpns, setVpns] = useState<string[]>([]);
  const [form, setForm] = useState<{ values: SqlFormValues; editing: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mssql/connections", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const doc = (await res.json()) as { connections: MssqlConnection[]; driver_available?: boolean };
      setConnections(doc.connections);
      setDriverAvailable(doc.driver_available !== false);
      setError(null);
    } catch {
      setConnections((c) => c ?? []);
      setError(t("errLoad"));
    }
  }, [t]);

  const loadVpns = useCallback(async () => {
    try {
      const res = await fetch("/api/vpn", { cache: "no-store" });
      if (!res.ok) return;
      const doc = (await res.json()) as { vpns?: VpnView[] };
      setVpns((doc.vpns ?? []).filter((v) => v && v.name).map((v) => v.name));
    } catch {
      /* picker stays at "No VPN" */
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
      void loadVpns();
    }, 0);
    return () => clearTimeout(timer);
  }, [load, loadVpns]);

  const upsert = (c: MssqlConnection) =>
    setConnections((list) => [...(list ?? []).filter((x) => x.name !== c.name), c]);

  const setField = <K extends keyof SqlFormValues>(field: K, value: SqlFormValues[K]) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  async function runTest(name: string) {
    setBusy(name);
    try {
      const res = await fetch(`${path(name)}/test`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      upsert(((await res.json()) as { connection: MssqlConnection }).connection);
    } catch {
      setError(t("errTest"));
    } finally {
      setBusy(null);
    }
  }

  async function saveAndTest() {
    if (!form || busy) return;
    const parsed = toSqlInput(form.values, form.editing, isOwner);
    if ("problem" in parsed) {
      setError(t(parsed.problem));
      return;
    }
    const name = form.values.name.trim();
    setBusy(name);
    setError(null);
    try {
      const res = await fetch(path(name), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.body),
      });
      if (!res.ok) {
        setError(t("errSave", { reason: await readError(res) }));
        return;
      }
      upsert(((await res.json()) as { connection: MssqlConnection }).connection);
      setForm(null);
      await runTest(name);
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    setBusy(name);
    try {
      const res = await fetch(path(name), { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      setConnections((list) => (list ?? []).filter((c) => c.name !== name));
      setRemoving(null);
    } catch {
      setError(t("errRemove"));
    } finally {
      setBusy(null);
    }
  }

  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: saveOnce } = useAction(saveAndTest);
  const v = form?.values;
  const vpnChoices = v?.vpn && !vpns.includes(v.vpn) ? [...vpns, v.vpn] : vpns;

  return (
    <section data-component="SqlServerConnections">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="text-xs text-[var(--color-muted)]">{t("description")}</p>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("perPerson")}</p>
      {!driverAvailable && <p className="mb-2 text-xs text-[var(--color-danger)]">{t("driverMissing")}</p>}
      {error && <p role="alert" className="mb-2 text-xs text-[var(--color-danger)]">{error}</p>}
      {connections === null && <p className="text-xs text-[var(--color-muted)]">{t("loading")}</p>}
      {connections && connections.length > 0 && (
        <ul className="mb-3 space-y-2">
          {connections.map((c) => (
            <ConnectionRow
              key={c.name}
              connection={c}
              t={t}
              busy={busy}
              onTest={() => runTest(c.name)}
              onEdit={() => setForm({ values: fromConnection(c), editing: true })}
              onRemove={() => setRemoving(c.name)}
            />
          ))}
        </ul>
      )}
      {connections && !form && (
        <button
          type="button"
          className={btnCls}
          disabled={!!busy}
          onClick={() => setForm({ values: EMPTY, editing: false })}
        >
          {t("add")}
        </button>
      )}
      {v && (
        <form
          data-mssql-form
          className="space-y-3 rounded border border-[var(--color-surface-2)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveOnce();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className={labelCls}>
              <span>{t("name")}</span>
              <input
                className={inputCls}
                placeholder={t("namePlaceholder")}
                value={v.name}
                disabled={form?.editing}
                onChange={(e) => setField("name", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span>{t("database")}</span>
              <input className={inputCls} value={v.database} onChange={(e) => setField("database", e.target.value)} />
            </label>
            <label className={labelCls}>
              <span>{t("host")}</span>
              <input
                className={inputCls}
                placeholder="sql01.yourcompany.local"
                value={v.host}
                onChange={(e) => setField("host", e.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className={labelCls}>
                <span>{t("port")}</span>
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={v.port}
                  onChange={(e) => setField("port", e.target.value)}
                />
              </label>
              <label className={labelCls}>
                <span>{t("instance")}</span>
                <input className={inputCls} value={v.instance} onChange={(e) => setField("instance", e.target.value)} />
              </label>
            </div>
            <label className={labelCls}>
              <span>{t("username")}</span>
              <input
                className={inputCls}
                autoComplete="off"
                value={v.username}
                onChange={(e) => setField("username", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span>{t("password")}</span>
              <input
                className={inputCls}
                type="password"
                aria-label={t("password")}
                autoComplete="new-password"
                value={v.password}
                placeholder={form?.editing ? "••••••••" : ""}
                onChange={(e) => setField("password", e.target.value)}
              />
              {form?.editing && <span className="block">{t("passwordKept")}</span>}
            </label>
            <label className={labelCls}>
              <span>{t("encrypt")}</span>
              <select
                className={`${inputCls} bg-[var(--color-surface)]`}
                value={v.encrypt}
                onChange={(e) => setField("encrypt", e.target.value as MssqlEncrypt)}
              >
                <option value="on">{t("encryptOn")}</option>
                <option value="strict">{t("encryptStrict")}</option>
                <option value="off">{t("encryptOff")}</option>
              </select>
            </label>
            <label className={labelCls}>
              <span>{t("vpn")}</span>
              <select
                className={`${inputCls} bg-[var(--color-surface)]`}
                value={v.vpn}
                onChange={(e) => setField("vpn", e.target.value)}
              >
                <option value="">{t("vpnNone")}</option>
                {vpnChoices.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="space-y-1">
            {v.encrypt !== "strict" && (
              <label className={checkCls}>
                <input
                  type="checkbox"
                  checked={v.trust_server_certificate}
                  onChange={(e) => setField("trust_server_certificate", e.target.checked)}
                />
                {t("trustCert")}
              </label>
            )}
            <label className={checkCls}>
              <input
                type="checkbox"
                checked={v.legacy_tls}
                onChange={(e) => setField("legacy_tls", e.target.checked)}
              />
              {t("legacyTls")}
            </label>
            {isOwner && (
              <label className={checkCls}>
                <input
                  type="checkbox"
                  checked={v.allow_writes}
                  onChange={(e) => setField("allow_writes", e.target.checked)}
                />
                {t("allowWrites")}
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryBtnCls} disabled={!!busy} aria-busy={!!busy}>
              {busy ? t("testing") : t("saveTest")}
            </button>
            <button type="button" className={btnCls} disabled={!!busy} onClick={() => setForm(null)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {removing && (
        <ConfirmDialog
          title={t("removeTitle", { name: removing })}
          body={t("removeBody")}
          confirmLabel={t("remove")}
          cancelLabel={t("cancel")}
          busy={busy === removing}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function ConnectionRow({
  connection: c, t, busy, onTest, onEdit, onRemove,
}: {
  connection: MssqlConnection;
  t: T;
  busy: string | null;
  onTest: () => unknown;
  onEdit: () => unknown;
  onRemove: () => void;
}) {
  const test = c.last_test;
  const testing = busy === c.name;
  const where = `${c.host}${c.instance ? `\\${c.instance}` : ""}${c.port ? `:${c.port}` : ""}`;
  return (
    <li data-component="SqlConnectionRow" className="rounded border border-[var(--color-surface-2)] p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{c.name}</span>
        <span data-mssql-state className={`shrink-0 ${STATE_COLOR[c.state]}`}>{t(STATE_KEY[c.state])}</span>
      </div>
      <p className="mt-1 break-all text-[var(--color-muted)]">
        {where} · {c.database} · {c.username}
        {c.vpn ? ` · ${t("viaVpn", { vpn: c.vpn })}` : ""}
        {" · "}
        {c.allow_writes ? t("writesAllowed") : t("readOnly")}
      </p>
      {test && (
        <p className={`mt-1 break-words ${test.ok ? "text-[var(--color-muted)]" : "text-[var(--color-danger)]"}`}>
          {test.ok
            ? t("testOk", { version: (test.server_version ?? "").split("\n")[0] })
            : t("testFail", { reason: test.error ?? "" })}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton busyLabel={t("testing")} className={btnCls} disabled={!!busy} aria-busy={testing} onAction={onTest}>
          {testing ? t("testing") : t("test")}
        </ActionButton>
        <button type="button" className={btnCls} disabled={!!busy} onClick={onEdit}>
          {t("edit")}
        </button>
        <button type="button" className={`${btnCls} text-[var(--color-danger)]`} disabled={!!busy} onClick={onRemove}>
          {t("remove")}
        </button>
      </div>
    </li>
  );
}
