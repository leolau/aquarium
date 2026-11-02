"use client";

/**
 * Settings → In&Out → Windows servers (PowerShell): the signed-in person's
 * own Windows servers reached over WinRM. Saved in the credential store as
 * `winrm` entries private to that person; Hermes `/api/winrm/connections`
 * never returns the password. "Save and test" saves, then signs in (through
 * the chosen VPN) and reads the PowerShell version and computer name. The
 * `windows_powershell` tool asks before every free-form command.
 */
import { useCallback, useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/i18n/client";
import { useAction } from "@/lib/use-action";
import type { VpnView, WinrmConnection, WinrmConnectionInput, WinrmTransport } from "@/types";

type T = ReturnType<typeof useT>;

export interface WinrmFormValues {
  name: string;
  host: string;
  port: "5986" | "5985";
  transport: WinrmTransport;
  username: string;
  password: string;
  verify_tls: boolean;
  legacy_tls: boolean;
  vpn: string;
}

const EMPTY: WinrmFormValues = {
  name: "", host: "", port: "5986", transport: "ntlm", username: "", password: "",
  verify_tls: true, legacy_tls: false, vpn: "",
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function fromConnection(c: WinrmConnection): WinrmFormValues {
  return {
    name: c.name, host: c.host, port: c.port === 5985 ? "5985" : "5986", transport: c.transport,
    username: c.username, password: "", verify_tls: c.verify_tls, legacy_tls: c.legacy_tls, vpn: c.vpn,
  };
}

/** Form → request body, or the message key of the problem to show. */
export function toWinrmInput(
  v: WinrmFormValues,
  editing: boolean,
): { body: WinrmConnectionInput } | { problem: string } {
  if ([v.name, v.host, v.username].some((x) => !x.trim())) return { problem: "errRequired" };
  if (!NAME_RE.test(v.name.trim())) return { problem: "errName" };
  if (!editing && !v.password) return { problem: "errPassword" };
  const https = v.port === "5986";
  return {
    body: {
      host: v.host.trim(),
      port: Number(v.port),
      transport: v.transport,
      username: v.username.trim(),
      ...(v.password ? { password: v.password } : {}),
      verify_tls: https ? v.verify_tls : true,
      legacy_tls: https ? v.legacy_tls : false,
      vpn: v.vpn,
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
  "rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-black disabled:opacity-50";

const STATE_KEY: Record<WinrmConnection["state"], string> = {
  working: "stateWorking",
  needs_attention: "stateNeedsAttention",
  untested: "stateUntested",
};
const STATE_COLOR: Record<WinrmConnection["state"], string> = {
  working: "text-[var(--color-accent)]",
  needs_attention: "text-red-400",
  untested: "text-[var(--color-muted)]",
};
const TRANSPORT_KEY: Record<WinrmTransport, string> = {
  ntlm: "transportNtlm",
  kerberos: "transportKerberos",
  credssp: "transportCredssp",
};

async function readError(res: Response): Promise<string> {
  try {
    const doc = (await res.json()) as { detail?: string; error?: string };
    return doc.detail || doc.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

const path = (name: string) => `/api/winrm/connections/${encodeURIComponent(name)}`;

export function WindowsServerConnections() {
  const t = useT("winrm");
  const [connections, setConnections] = useState<WinrmConnection[] | null>(null);
  const [driverAvailable, setDriverAvailable] = useState(true);
  const [vpns, setVpns] = useState<string[]>([]);
  const [form, setForm] = useState<{ values: WinrmFormValues; editing: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/winrm/connections", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const doc = (await res.json()) as { connections: WinrmConnection[]; driver_available?: boolean };
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

  const upsert = (c: WinrmConnection) =>
    setConnections((list) => [...(list ?? []).filter((x) => x.name !== c.name), c]);

  const setField = <K extends keyof WinrmFormValues>(field: K, value: WinrmFormValues[K]) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  async function runTest(name: string) {
    setBusy(name);
    try {
      const res = await fetch(`${path(name)}/test`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      upsert(((await res.json()) as { connection: WinrmConnection }).connection);
    } catch {
      setError(t("errTest"));
    } finally {
      setBusy(null);
    }
  }

  async function saveAndTest() {
    if (!form || busy) return;
    const parsed = toWinrmInput(form.values, form.editing);
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
      upsert(((await res.json()) as { connection: WinrmConnection }).connection);
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
    <section data-component="WindowsServerConnections">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="text-xs text-[var(--color-muted)]">{t("description")}</p>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("perPerson")}</p>
      {!driverAvailable && <p className="mb-2 text-xs text-red-400">{t("driverMissing")}</p>}
      {error && <p role="alert" className="mb-2 text-xs text-red-400">{error}</p>}
      {connections === null && <p className="text-xs text-[var(--color-muted)]">{t("loading")}</p>}
      {connections && connections.length > 0 && (
        <ul className="mb-3 space-y-2">
          {connections.map((c) => (
            <ServerRow
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
          data-winrm-form
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
              <span>{t("host")}</span>
              <input
                className={inputCls}
                placeholder="app01.yourcompany.local"
                value={v.host}
                onChange={(e) => setField("host", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span>{t("port")}</span>
              <select
                className={`${inputCls} bg-[var(--color-surface)]`}
                value={v.port}
                onChange={(e) => setField("port", e.target.value as WinrmFormValues["port"])}
              >
                <option value="5986">{t("portHttps")}</option>
                <option value="5985">{t("portHttp")}</option>
              </select>
            </label>
            <label className={labelCls}>
              <span>{t("transport")}</span>
              <select
                className={`${inputCls} bg-[var(--color-surface)]`}
                value={v.transport}
                onChange={(e) => setField("transport", e.target.value as WinrmTransport)}
              >
                {(Object.keys(TRANSPORT_KEY) as WinrmTransport[]).map((tr) => (
                  <option key={tr} value={tr}>{t(TRANSPORT_KEY[tr])}</option>
                ))}
              </select>
            </label>
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
          {v.port === "5986" && (
            <div className="space-y-1">
              <label className={checkCls}>
                <input
                  type="checkbox"
                  checked={v.verify_tls}
                  onChange={(e) => setField("verify_tls", e.target.checked)}
                />
                {t("verifyTls")}
              </label>
              <label className={checkCls}>
                <input
                  type="checkbox"
                  checked={v.legacy_tls}
                  onChange={(e) => setField("legacy_tls", e.target.checked)}
                />
                {t("legacyTls")}
              </label>
            </div>
          )}
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

function ServerRow({
  connection: c, t, busy, onTest, onEdit, onRemove,
}: {
  connection: WinrmConnection;
  t: T;
  busy: string | null;
  onTest: () => unknown;
  onEdit: () => unknown;
  onRemove: () => void;
}) {
  const test = c.last_test;
  const testing = busy === c.name;
  return (
    <li data-component="WinrmServerRow" className="rounded border border-[var(--color-surface-2)] p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{c.name}</span>
        <span data-winrm-state className={`shrink-0 ${STATE_COLOR[c.state]}`}>{t(STATE_KEY[c.state])}</span>
      </div>
      <p className="mt-1 break-all text-[var(--color-muted)]">
        {c.host}:{c.port} · {c.username} · {t(TRANSPORT_KEY[c.transport] ?? "transportNtlm")}
        {c.vpn ? ` · ${t("viaVpn", { vpn: c.vpn })}` : ""}
      </p>
      {test && (
        <p className={`mt-1 break-words ${test.ok ? "text-[var(--color-muted)]" : "text-red-400"}`}>
          {test.ok
            ? t("testOk", { computer: test.computer_name ?? "", version: test.ps_version ?? "" })
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
        <button type="button" className={`${btnCls} text-red-400`} disabled={!!busy} onClick={onRemove}>
          {t("remove")}
        </button>
      </div>
    </li>
  );
}
