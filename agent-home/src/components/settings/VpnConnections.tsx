"use client";

/**
 * Settings → In&Out → Private networks (VPN): Fortinet SSL-VPN logins that
 * let Hermes reach an office network over a split tunnel. A VPN here is only
 * the connection; the shares it reads are network folders (Files → Bridge),
 * and only their file servers are routed through it. Entries live in the unified credential store
 * (kind `fortinet-vpn`, provider `fortinet`); tunnel state and actions come
 * from Hermes `/api/vpn`. Agents connect themselves with `hermes vpn up`.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type {
  CredentialEntry,
  FortinetVpnPayload,
  VpnCert,
  VpnState,
  VpnView,
} from "@/types";

const PROVIDER = "fortinet";
const KIND = "fortinet-vpn";
const SECRET_FIELDS = ["password", "share_password"] as const;
/** Fields of the old one-share-per-VPN setup. Hermes keeps them on legacy
 *  entries until migrated; the form never sends them. */
const LEGACY_FIELDS = [
  "routes",
  "share_path",
  "share_username",
  "share_password",
  "share_domain",
] as const;
const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 30_000;

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** Normalise a fingerprint to 64 lowercase hex chars (strips colons). */
export function normalizeFingerprint(sha: string): string {
  return sha.toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** Fingerprint grouped in 16-char chunks for reading aloud / comparing. */
export function groupFingerprint(sha: string): string {
  return (normalizeFingerprint(sha).match(/.{1,16}/g) ?? []).join(" ");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A timestamp in the browser's own time zone: "10:42 GMT+8" today,
 *  "2026-10-01 16:20 GMT+8" otherwise. */
export function formatLocalTime(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${sameDay ? time : `${date} ${time}`}${tz ? ` ${tz}` : ""}`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const STATE_LABEL: Record<VpnState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Not connected",
  error: "Error",
  needs_cert: "Needs certificate",
};

const STATE_COLOR: Record<VpnState, string> = {
  connected: "text-green-400",
  connecting: "text-[var(--color-warn-text)]",
  disconnected: "text-[var(--color-muted)]",
  error: "text-red-400",
  needs_cert: "text-[var(--color-warn-text)]",
};

interface FormValues {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  realm: string;
  visibility: "private" | "shared";
}

const EMPTY_FORM: FormValues = {
  name: "",
  host: "",
  port: "443",
  username: "",
  password: "",
  realm: "",
  visibility: "private",
};

type FormState = { mode: "add" | "edit"; values: FormValues; base: Record<string, unknown> };

/** Validate the form; returns the first problem or null. */
export function formError(values: FormValues, mode: "add" | "edit"): string | null {
  if (!values.name.trim()) return "Give the VPN a name, e.g. Office files.";
  const host = values.host.trim();
  if (!host) return "Enter the VPN gateway address.";
  if (host.includes("://") || !HOST_RE.test(host)) {
    return "Enter just the gateway host name or IP (no https:// or path), e.g. vpn.example.com.";
  }
  const port = Number(values.port.trim() || "443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be a number from 1 to 65535.";
  }
  if (!values.username.trim()) return "Enter the VPN username.";
  if (mode === "add" && !values.password) return "Enter the VPN password.";
  return null;
}

/**
 * The PUT payload. Starts from the stored (secret-free) payload so fields
 * the form doesn't show (trusted_cert, auto_connect, idle_minutes) survive
 * an Edit; a blank password is left out so Hermes keeps the stored one.
 * Legacy route/share fields are never sent — Hermes keeps them on the entry.
 */
export function buildPayload(
  values: FormValues,
  base: Record<string, unknown>,
): FortinetVpnPayload {
  const payload: Record<string, unknown> = { ...base };
  for (const f of SECRET_FIELDS) delete payload[f];
  for (const f of LEGACY_FIELDS) delete payload[f];
  payload.host = values.host.trim();
  payload.port = Number(values.port.trim() || "443");
  payload.username = values.username.trim();
  const realm = values.realm.trim();
  if (realm) payload.realm = realm;
  else delete payload.realm;
  if (values.password) payload.password = values.password;
  if (payload.auto_connect === undefined) payload.auto_connect = true;
  if (payload.idle_minutes === undefined) payload.idle_minutes = 30;
  return payload as unknown as FortinetVpnPayload;
}

function credentialUrl(name: string): string {
  return `/api/credentials/${PROVIDER}/${encodeURIComponent(name)}`;
}

async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: unknown };
    if (typeof data.detail === "string" && data.detail) return data.detail;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** The stored payload (secrets already stripped by Hermes). */
async function loadStoredPayload(name: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(credentialUrl(name));
    if (!res.ok) return null;
    const data = (await res.json()) as { credential: CredentialEntry };
    const payload = { ...(data.credential.payload ?? {}) };
    for (const f of SECRET_FIELDS) delete payload[f];
    return payload;
  } catch {
    return null;
  }
}

const inputCls =
  "w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1 text-xs";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";
const btnCls =
  "rounded border border-[var(--color-surface-2)] px-2 py-1 text-xs font-semibold disabled:opacity-50";
const primaryBtnCls =
  "rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-black disabled:opacity-50";

export function VpnConnections() {
  const [vpns, setVpns] = useState<VpnView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [dismissedCerts, setDismissedCerts] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<VpnView | null>(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/vpn", { cache: "no-store" });
      if (!mounted.current) return;
      if (res.ok) {
        const data = (await res.json()) as { vpns: VpnView[] };
        setVpns((data.vpns ?? []).filter((v) => v && v.status));
        setError(null);
      } else {
        setError("Could not load private networks.");
      }
    } catch {
      if (mounted.current) setError("Could not load private networks.");
    }
    if (mounted.current) setLoaded(true);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const t = setTimeout(() => void reload(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(t);
    };
  }, [reload]);

  const anyConnecting = vpns.some((v) => v.status.state === "connecting");
  useEffect(() => {
    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const id = setInterval(
      () => {
        if (visible()) void reload();
      },
      anyConnecting ? POLL_FAST_MS : POLL_SLOW_MS,
    );
    const onVisible = () => {
      if (visible()) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyConnecting, reload]);

  const replaceVpn = useCallback((vpn: VpnView) => {
    setVpns((prev) => {
      const i = prev.findIndex((v) => v.name === vpn.name);
      if (i === -1) return [...prev, vpn];
      const next = [...prev];
      next[i] = vpn;
      return next;
    });
  }, []);

  /** POST /api/vpn/{name}/{action}; connection failures arrive as a 200 VpnView. */
  const runAction = useCallback(
    async (
      name: string,
      action: "connect" | "disconnect" | "test" | "trust",
      body?: unknown,
    ) => {
      setBusy((b) => ({ ...b, [name]: action }));
      setNotice((n) => {
        const next = { ...n };
        delete next[name];
        return next;
      });
      try {
        const res = await fetch(
          `/api/vpn/${encodeURIComponent(name)}/${action}`,
          {
            method: "POST",
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        if (res.ok) {
          const data = (await res.json()) as { vpn?: VpnView };
          if (data.vpn?.status) replaceVpn(data.vpn);
          else await reload();
        } else {
          const detail = await errorDetail(res, `Could not ${action} ${name}.`);
          setNotice((n) => ({ ...n, [name]: detail }));
        }
      } catch {
        setNotice((n) => ({ ...n, [name]: `Could not ${action} ${name}.` }));
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[name];
          return next;
        });
      }
    },
    [replaceVpn, reload],
  );

  const openAdd = useCallback(() => {
    setFormProblem(null);
    setForm({ mode: "add", values: { ...EMPTY_FORM }, base: {} });
  }, []);

  const openEdit = useCallback(async (vpn: VpnView) => {
    setFormProblem(null);
    const stored = await loadStoredPayload(vpn.name);
    if (!stored) {
      setNotice((n) => ({ ...n, [vpn.name]: "Could not load this VPN's settings." }));
      return;
    }
    const str = (k: string) => (typeof stored[k] === "string" ? (stored[k] as string) : "");
    setForm({
      mode: "edit",
      base: stored,
      values: {
        name: vpn.name,
        host: str("host") || vpn.host,
        port: String(stored.port ?? vpn.port ?? 443),
        username: str("username"),
        password: "",
        realm: str("realm"),
        visibility: vpn.visibility.startsWith("private") ? "private" : "shared",
      },
    });
  }, []);

  const save = useCallback(async () => {
    if (!form) return;
    const problem = formError(form.values, form.mode);
    if (problem) {
      setFormProblem(problem);
      return;
    }
    const name = form.values.name.trim();
    if (form.mode === "add" && vpns.some((v) => v.name === name)) {
      setFormProblem(`A VPN called "${name}" already exists — pick another name or edit it.`);
      return;
    }
    setFormProblem(null);
    setSaving(true);
    try {
      const res = await fetch(credentialUrl(name), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: KIND,
          payload: buildPayload(form.values, form.base),
          visibility: form.values.visibility,
        }),
      });
      if (!res.ok) {
        setFormProblem(await errorDetail(res, "Could not save the VPN."));
        return;
      }
    } catch {
      setFormProblem("Could not save the VPN.");
      return;
    } finally {
      setSaving(false);
    }
    setForm(null);
    await reload();
    await runAction(name, "test");
  }, [form, vpns, reload, runAction]);

  const setAutoConnect = useCallback(
    async (vpn: VpnView, on: boolean) => {
      replaceVpn({ ...vpn, auto_connect: on });
      const stored = await loadStoredPayload(vpn.name);
      if (stored) for (const f of LEGACY_FIELDS) delete stored[f];
      const res = stored
        ? await fetch(credentialUrl(vpn.name), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: KIND,
              payload: { ...stored, auto_connect: on },
              visibility: vpn.visibility,
            }),
          }).catch(() => null)
        : null;
      if (!res?.ok) {
        replaceVpn(vpn);
        setNotice((n) => ({ ...n, [vpn.name]: "Could not update the setting; reload to resync." }));
      }
    },
    [replaceVpn],
  );

  const remove = useCallback(async (vpn: VpnView) => {
    const res = await fetch(credentialUrl(vpn.name), { method: "DELETE" });
    if (res.ok) {
      setVpns((prev) => prev.filter((v) => v.name !== vpn.name));
    } else {
      setError("Could not remove the VPN; reload to resync.");
    }
  }, []);

  const setField = (field: keyof FormValues, value: string) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  return (
    <section data-component="VpnConnections">
      <h2 className="text-sm font-semibold">Private networks (VPN)</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Connect Hermes to an office network so it can read files there. Only
        traffic to the file servers of your network folders goes through the
        VPN; everything else (WhatsApp, email, models) stays on the normal
        internet.
      </p>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      {loaded && vpns.length === 0 && !form && (
        <p className="mb-2 text-xs text-[var(--color-muted)]">
          No private networks yet.
        </p>
      )}

      <ul className="mb-3 space-y-2">
        {vpns.map((vpn) => {
          const cert = vpn.status.cert;
          const showCert =
            vpn.status.state === "needs_cert" &&
            !!cert &&
            dismissedCerts[vpn.name] !== normalizeFingerprint(cert.sha256);
          return (
            <VpnCard
              key={vpn.name}
              vpn={vpn}
              busy={busy[vpn.name] ?? null}
              notice={notice[vpn.name] ?? null}
              certDismissed={vpn.status.state === "needs_cert" && !showCert}
              onConnect={() => {
                setDismissedCerts((d) => {
                  const next = { ...d };
                  delete next[vpn.name];
                  return next;
                });
                void runAction(vpn.name, "connect");
              }}
              onDisconnect={() => void runAction(vpn.name, "disconnect")}
              onTest={() => void runAction(vpn.name, "test")}
              onEdit={() => void openEdit(vpn)}
              onRemove={() => setConfirmRemove(vpn)}
              onAutoConnect={(on) => void setAutoConnect(vpn, on)}
            >
              {showCert && cert && (
                <CertPanel
                  vpn={vpn}
                  cert={cert}
                  busy={!!busy[vpn.name]}
                  onTrust={() =>
                    void runAction(vpn.name, "trust", {
                      sha256: normalizeFingerprint(cert.sha256),
                    })
                  }
                  onReject={() =>
                    setDismissedCerts((d) => ({
                      ...d,
                      [vpn.name]: normalizeFingerprint(cert.sha256),
                    }))
                  }
                />
              )}
            </VpnCard>
          );
        })}
      </ul>

      {!form && (
        <button type="button" className={btnCls} onClick={openAdd}>
          + Add a Fortinet VPN
        </button>
      )}

      {form && (
        <div
          data-vpn-form={form.mode}
          className="space-y-2 rounded border border-[var(--color-surface-2)] p-2"
        >
          <p className="text-xs font-semibold">
            {form.mode === "add" ? "Add a Fortinet VPN" : `Edit "${form.values.name}"`}
          </p>
          {form.mode === "add" && (
            <label className={labelCls}>
              <span>Name</span>
              <input
                value={form.values.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="Office files"
                className={inputCls}
              />
            </label>
          )}
          <div className="flex gap-2">
            <label className={`${labelCls} flex-1`}>
              <span>VPN gateway</span>
              <input
                value={form.values.host}
                onChange={(e) => setField("host", e.target.value)}
                placeholder="vpn.example-office.com"
                className={inputCls}
              />
            </label>
            <label className={`${labelCls} w-20`}>
              <span>Port</span>
              <input
                value={form.values.port}
                onChange={(e) => setField("port", e.target.value)}
                inputMode="numeric"
                className={inputCls}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <label className={`${labelCls} flex-1`}>
              <span>Username</span>
              <input
                value={form.values.username}
                onChange={(e) => setField("username", e.target.value)}
                autoComplete="off"
                className={inputCls}
              />
            </label>
            <label className={`${labelCls} flex-1`}>
              <span>Password</span>
              <input
                type="password"
                value={form.values.password}
                onChange={(e) => setField("password", e.target.value)}
                placeholder={form.mode === "edit" ? "unchanged" : ""}
                autoComplete="new-password"
                className={inputCls}
              />
            </label>
          </div>
          <label className={labelCls}>
            <span>Realm (optional)</span>
            <input
              value={form.values.realm}
              onChange={(e) => setField("realm", e.target.value)}
              placeholder="leave blank unless FortiClient asks for one"
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            <span>Who can use it</span>
            <select
              value={form.values.visibility}
              onChange={(e) =>
                setField("visibility", e.target.value === "shared" ? "shared" : "private")
              }
              className={inputCls}
            >
              <option value="private">private (my agents only)</option>
              <option value="shared">shared (everyone on this Hermes)</option>
            </select>
          </label>
          <p data-vpn-folders-note className="text-xs text-[var(--color-muted)]">
            Only the VPN connection is set up here. To read files, add a network
            folder in{" "}
            <Link href="/files/bridge" className="underline">
              Files → Bridge
            </Link>{" "}
            with its \\server\share path. Only traffic to those file servers goes
            through the VPN.
          </p>
          {formProblem && <p className="text-xs text-red-400">{formProblem}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className={primaryBtnCls}
            >
              {saving ? "Saving…" : "Save & test connection"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setForm(null);
                setFormProblem(null);
              }}
              className={btnCls}
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            Passwords are stored encrypted in the credential store and never
            shown again.
            {form.mode === "edit" && " Leave a password blank to keep the saved one."}
          </p>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove VPN?"
          body={`Remove ${confirmRemove.name}? Hermes disconnects it, unmounts its files and deletes the saved login — agents can no longer reach that network until you add it again.`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const vpn = confirmRemove;
            setConfirmRemove(null);
            void remove(vpn);
          }}
        />
      )}
    </section>
  );
}

function VpnCard({
  vpn,
  busy,
  notice,
  certDismissed,
  children,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onRemove,
  onAutoConnect,
}: {
  vpn: VpnView;
  busy: string | null;
  notice: string | null;
  certDismissed: boolean;
  children?: ReactNode;
  onConnect(): void;
  onDisconnect(): void;
  onTest(): void;
  onEdit(): void;
  onRemove(): void;
  onAutoConnect(on: boolean): void;
}) {
  const { status } = vpn;
  const state = status.state;
  const connected = state === "connected";
  const connecting = state === "connecting" || busy === "connect" || busy === "trust";
  const since = formatLocalTime(status.since);
  const lastUsed = formatLocalTime(status.last_used);
  const check = status.last_check;
  const checkAt = check ? formatLocalTime(check.at) : null;
  const gateway = vpn.port && vpn.port !== 443 ? `${vpn.host}:${vpn.port}` : vpn.host;

  return (
    <li
      data-vpn={vpn.slug}
      data-state={state}
      className="rounded border border-[var(--color-surface-2)] p-2 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {vpn.name}{" "}
          <span className="font-normal text-[var(--color-muted)]">
            ({KIND}
            {vpn.visibility === "shared" ? ", shared" : ""})
          </span>
        </span>
        <button type="button" className="text-red-400" onClick={onRemove}>
          Remove
        </button>
      </div>

      {busy === "test" || busy === "connect" || busy === "trust" ? (
        <p className="mt-1 font-semibold">
          {busy === "test" ? `Testing "${vpn.name}"…` : `Connecting "${vpn.name}"…`}
        </p>
      ) : null}

      <p className="mt-1 text-[var(--color-muted)]">
        <span data-vpn-state className={STATE_COLOR[state]}>
          {connected ? "●" : "○"} {STATE_LABEL[state]}
        </span>
        {connected && since && ` since ${since}`}
        {` · gateway ${gateway}`}
        {connected && status.local_ip && ` · address ${status.local_ip}`}
        {!connected && lastUsed && ` · last used ${lastUsed}`}
      </p>

      {vpn.routes.length > 0 && (
        <p className="mt-1 text-[var(--color-muted)]">
          Routes through VPN:{" "}
          {vpn.routes.map((r) => (
            <code
              key={r}
              className="mr-1 rounded bg-[var(--color-surface-2)] px-1 text-[var(--color-text)]"
            >
              {r}
            </code>
          ))}
        </p>
      )}

      {vpn.share_path && (
        <p className="mt-1 break-all text-[var(--color-muted)]">
          Files:{" "}
          <code className="rounded bg-[var(--color-surface-2)] px-1 text-[var(--color-text)]">
            {vpn.share_path}
          </code>
          {vpn.mount_path && (
            <>
              {" → read-only at "}
              <code className="rounded bg-[var(--color-surface-2)] px-1 text-[var(--color-text)]">
                {vpn.mount_path}
              </code>
            </>
          )}
          {" · "}
          <Link href="/files/bridge" data-vpn-move-share className="underline">
            Move this to Files → Bridge
          </Link>
        </p>
      )}

      {check && (
        <p className={`mt-1 ${check.ok ? "text-[var(--color-muted)]" : "text-red-400"}`}>
          Last check{checkAt ? ` ${checkAt}` : ""}: {check.message}
        </p>
      )}

      {state === "connected" && status.share_error && (
        <p className="mt-1 text-red-400">
          VPN connected, but the files are not available: &ldquo;{status.share_error}&rdquo;
        </p>
      )}

      {state === "error" && status.error && (
        <p className="mt-1 text-red-400">Last attempt failed: &ldquo;{status.error}&rdquo;</p>
      )}

      {certDismissed && (
        <p className="mt-1 text-[var(--color-warn-text)]">
          Not connected — the gateway&apos;s certificate isn&apos;t trusted.
          Connect again to review it.
        </p>
      )}

      {notice && <p className="mt-1 text-red-400">{notice}</p>}

      {children}

      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={vpn.auto_connect}
          onChange={(e) => onAutoConnect(e.target.checked)}
        />
        Let agents connect on their own when they need these files
      </label>
      <p className="text-[var(--color-muted)]">
        Disconnects after {vpn.idle_minutes} minutes with no file access.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {connected ? (
          <button type="button" disabled={!!busy} onClick={onDisconnect} className={btnCls}>
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            disabled={!!busy || connecting}
            onClick={onConnect}
            className={primaryBtnCls}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        )}
        <button
          type="button"
          disabled={!!busy || connecting}
          onClick={onTest}
          className={btnCls}
        >
          {busy === "test" ? "Testing…" : "Test again"}
        </button>
        <button type="button" disabled={!!busy} onClick={onEdit} className={btnCls}>
          Edit
        </button>
      </div>
    </li>
  );
}

function CertPanel({
  vpn,
  cert,
  busy,
  onTrust,
  onReject,
}: {
  vpn: VpnView;
  cert: VpnCert;
  busy: boolean;
  onTrust(): void;
  onReject(): void;
}) {
  return (
    <div
      data-vpn-cert
      className="mt-2 space-y-2 rounded border border-[var(--color-warn)] p-2"
    >
      <p className="text-sm font-semibold text-[var(--color-warn-text)]">
        Trust this VPN gateway&apos;s certificate?
      </p>
      <p className="text-[var(--color-muted)]">
        The gateway{" "}
        <code className="rounded bg-[var(--color-surface-2)] px-1 text-[var(--color-text)]">
          {vpn.host}:{vpn.port}
        </code>{" "}
        presented a certificate that isn&apos;t from a public authority, so
        Hermes stopped before sending your password.
      </p>
      <dl className="space-y-0.5">
        <div>
          <dt className="inline">Issued to: </dt>
          <dd className="inline">
            <code className="rounded bg-[var(--color-surface-2)] px-1">{cert.subject ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt className="inline">Issued by: </dt>
          <dd className="inline">
            <code className="rounded bg-[var(--color-surface-2)] px-1">{cert.issuer ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt className="inline">Valid until: </dt>
          <dd className="inline">{formatDate(cert.not_after) ?? "—"}</dd>
        </div>
        <div>
          <dt>SHA-256 fingerprint:</dt>
          <dd>
            <code
              data-vpn-fingerprint
              className="break-all rounded bg-[var(--color-surface-2)] px-1"
            >
              {groupFingerprint(cert.sha256)}
            </code>
          </dd>
        </div>
      </dl>
      <p className="text-[var(--color-muted)]">
        Check the fingerprint with whoever runs the VPN (or with FortiClient&apos;s
        certificate warning on your own computer) before trusting it.
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onTrust} className={primaryBtnCls}>
          Trust and connect
        </button>
        <button type="button" disabled={busy} onClick={onReject} className={btnCls}>
          Don&apos;t trust
        </button>
      </div>
    </div>
  );
}
