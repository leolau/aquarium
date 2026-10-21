"use client";

/**
 * Files → Bridge → Network folders (through a VPN): SMB shares on an office
 * file server that Hermes mounts read-only through one of the user's
 * Fortinet VPNs (Settings → In&Out → Private networks). Unlike the Mac
 * folders above, these live server-side (Hermes `/api/vpn/folders`,
 * credential kind `smb-folder`), so the agent can use them while this page
 * is closed and the browser bridge is disconnected.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatLocalTime } from "@/components/settings/VpnConnections";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  displaySmbPath,
  normalizeSmbPath,
} from "@/lib/folder-bridge/networkFolders";
import type { NetworkFolderInput, NetworkFolderView, VpnState, VpnView } from "@/types";

const POLL_MS = 30_000;

const VPN_CHIP: Record<VpnState, string> = {
  connected: "VPN connected",
  connecting: "VPN connecting…",
  disconnected: "VPN off",
  error: "VPN error",
  needs_cert: "VPN needs certificate",
};

export interface NetworkFolderFormValues {
  name: string;
  vpn: string;
  share_path: string;
  share_username: string;
  share_password: string;
  share_domain: string;
  trusted_for_import: boolean;
}

type FormState = {
  mode: "add" | "edit";
  /** Name of the folder being edited (the PUT target); null when adding. */
  original: string | null;
  values: NetworkFolderFormValues;
  /** Saved at least once in this form, so Cancel just closes it. */
  saved: boolean;
};

type TestResult = { ok: boolean; text: string };

/** Validate the form; returns the first problem or null. */
export function networkFolderFormError(
  values: NetworkFolderFormValues,
  takenNames: string[],
): string | null {
  const name = values.name.trim();
  if (!name) return "Give the folder a name the agent will see, e.g. Tender documents.";
  if (takenNames.includes(name)) {
    return `A network folder called "${name}" already exists — pick another name.`;
  }
  if (!values.vpn) return "Choose the VPN that reaches this file server.";
  const { error } = normalizeSmbPath(values.share_path);
  if (error) return error;
  if (!values.share_username.trim() && (values.share_password || values.share_domain.trim())) {
    return "Enter the share username, or clear the share password and domain to use the VPN's login.";
  }
  return null;
}

/** The POST/PUT body. A blank password is left out so Hermes keeps the
 *  stored one; a blank share username means the VPN's login is used. */
export function buildNetworkFolderInput(values: NetworkFolderFormValues): NetworkFolderInput {
  const input: NetworkFolderInput = {
    name: values.name.trim(),
    vpn: values.vpn,
    share_path: normalizeSmbPath(values.share_path).path,
    trusted_for_import: values.trusted_for_import,
    share_username: null,
    share_domain: null,
  };
  const username = values.share_username.trim();
  if (username) {
    input.share_username = username;
    input.share_domain = values.share_domain.trim() || null;
    if (values.share_password) input.share_password = values.share_password;
  }
  return input;
}

function testResult(folder: NetworkFolderView): TestResult {
  const check = folder.status.last_check;
  if (!check && folder.status.mounted && !folder.status.error) {
    return { ok: true, text: "Test OK: share mounted read-only." };
  }
  if (check?.ok) {
    const text =
      check.message ||
      `share mounted read-only${check.file_count !== null ? `, ${check.file_count} files in the top folder` : ""}.`;
    return { ok: true, text: `Test OK: ${text}` };
  }
  const why = check?.message || folder.status.error || "the share could not be mounted.";
  return { ok: false, text: `Test failed: ${why}` };
}

/** The red line under a row: the last failed test, or a mount/VPN error. */
function rowError(folder: NetworkFolderView): string | null {
  const check = folder.status.last_check;
  if (check && !check.ok) {
    const at = formatLocalTime(check.at);
    const msg = check.message || folder.status.error || "the share could not be mounted";
    return `${folder.name} — last test${at ? ` ${at}` : ""}: ${msg}`;
  }
  if (folder.status.error) return `${folder.name}: ${folder.status.error}`;
  return null;
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

function folderUrl(name: string, action?: string): string {
  return `/api/vpn/folders/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;
}

function isFolderView(v: unknown): v is NetworkFolderView {
  return !!v && typeof v === "object" && "name" in v && "status" in v;
}

const sectionCls =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const btnCls =
  "rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50";
const chipCls =
  "shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)]";
const inputCls =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";

const EMPTY_VALUES: NetworkFolderFormValues = {
  name: "",
  vpn: "",
  share_path: "",
  share_username: "",
  share_password: "",
  share_domain: "",
  trusted_for_import: false,
};

export function NetworkFolders() {
  const [folders, setFolders] = useState<NetworkFolderView[]>([]);
  const [vpns, setVpns] = useState<VpnView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [vpnsLoaded, setVpnsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<"saving" | "testing" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<NetworkFolderView | null>(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const [foldersRes, vpnsRes] = await Promise.all([
      fetch("/api/vpn/folders", { cache: "no-store" }).catch(() => null),
      fetch("/api/vpn", { cache: "no-store" }).catch(() => null),
    ]);
    if (!mounted.current) return;
    if (foldersRes?.ok) {
      const data = (await foldersRes.json().catch(() => ({}))) as { folders?: unknown[] };
      if (!mounted.current) return;
      setFolders((data.folders ?? []).filter(isFolderView));
      setLoadError(null);
    } else {
      setLoadError("Could not load network folders.");
    }
    if (vpnsRes?.ok) {
      const data = (await vpnsRes.json().catch(() => ({}))) as { vpns?: VpnView[] };
      if (!mounted.current) return;
      setVpns((data.vpns ?? []).filter((v) => v && typeof v.name === "string"));
      setVpnsLoaded(true);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const t = setTimeout(() => void reload(), 0);
    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const id = setInterval(() => {
      if (visible()) void reload();
    }, POLL_MS);
    const onVisible = () => {
      if (visible()) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearTimeout(t);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const upsert = useCallback((folder: NetworkFolderView, replacing?: string | null) => {
    setFolders((prev) => {
      const key = replacing ?? folder.name;
      if (!prev.some((f) => f.name === key)) {
        return [...prev.filter((f) => f.name !== folder.name), folder];
      }
      return prev
        .filter((f) => f.name === key || f.name !== folder.name)
        .map((f) => (f.name === key ? folder : f));
    });
  }, []);

  const setBusyFor = (name: string, action: string | null) =>
    setBusy((b) => {
      const next = { ...b };
      if (action) next[name] = action;
      else delete next[name];
      return next;
    });

  /** POST …/test; a failed test is a 200 view with last_check.ok false. */
  const runTest = useCallback(
    async (name: string): Promise<NetworkFolderView | null> => {
      setBusyFor(name, "test");
      setNotice((n) => {
        const next = { ...n };
        delete next[name];
        return next;
      });
      try {
        const res = await fetch(folderUrl(name, "test"), { method: "POST" });
        if (!res.ok) {
          const detail = await errorDetail(res, `Could not test ${name}.`);
          setNotice((n) => ({ ...n, [name]: detail }));
          return null;
        }
        const view = (await res.json()) as unknown;
        if (!isFolderView(view)) return null;
        upsert(view);
        return view;
      } catch {
        setNotice((n) => ({ ...n, [name]: `Could not test ${name}.` }));
        return null;
      } finally {
        setBusyFor(name, null);
      }
    },
    [upsert],
  );

  const openAdd = () => {
    setFormProblem(null);
    setResult(null);
    setForm({
      mode: "add",
      original: null,
      saved: false,
      values: { ...EMPTY_VALUES, vpn: vpns[0]?.name ?? "" },
    });
  };

  const openEdit = (folder: NetworkFolderView) => {
    setFormProblem(null);
    setResult(null);
    setForm({
      mode: "edit",
      original: folder.name,
      saved: false,
      values: {
        name: folder.name,
        vpn: folder.vpn,
        share_path: displaySmbPath(folder.share_path),
        share_username: folder.share_username ?? "",
        share_password: "",
        share_domain: folder.share_domain ?? "",
        trusted_for_import: folder.trusted_for_import,
      },
    });
  };

  const setField = <K extends keyof NetworkFolderFormValues>(
    field: K,
    value: NetworkFolderFormValues[K],
  ) => setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  const save = async () => {
    if (!form) return;
    const taken = folders.map((f) => f.name).filter((n) => n !== form.original);
    const problem = networkFolderFormError(form.values, taken);
    if (problem) {
      setFormProblem(problem);
      return;
    }
    setFormProblem(null);
    setResult(null);
    setSaving("saving");
    const input = buildNetworkFolderInput(form.values);
    let saved: NetworkFolderView | null = null;
    try {
      const res = await fetch(
        form.original ? folderUrl(form.original) : "/api/vpn/folders",
        {
          method: form.original ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        setFormProblem(await errorDetail(res, "Could not save the network folder."));
        return;
      }
      const view = (await res.json()) as unknown;
      saved = isFolderView(view) ? view : null;
    } catch {
      setFormProblem("Could not save the network folder.");
      return;
    } finally {
      setSaving(null);
    }
    const name = saved?.name ?? input.name;
    if (saved) upsert(saved, form.original);
    else await reload();
    setForm((f) =>
      f
        ? {
            ...f,
            mode: "edit",
            original: name,
            saved: true,
            values: {
              ...f.values,
              share_path: displaySmbPath(input.share_path),
              share_password: "",
            },
          }
        : f,
    );
    setSaving("testing");
    const tested = await runTest(name);
    if (mounted.current) {
      setSaving(null);
      setResult(
        tested ? testResult(tested) : { ok: false, text: "Saved, but the test could not run." },
      );
    }
  };

  const remove = async (folder: NetworkFolderView) => {
    setBusyFor(folder.name, "remove");
    try {
      const res = await fetch(folderUrl(folder.name), { method: "DELETE" });
      if (res.ok) {
        setFolders((prev) => prev.filter((f) => f.name !== folder.name));
        if (form?.original === folder.name) setForm(null);
      } else {
        const detail = await errorDetail(res, `Could not remove ${folder.name}.`);
        setNotice((n) => ({ ...n, [folder.name]: detail }));
      }
    } catch {
      setNotice((n) => ({ ...n, [folder.name]: `Could not remove ${folder.name}.` }));
    } finally {
      setBusyFor(folder.name, null);
    }
  };

  const noVpn = vpnsLoaded && vpns.length === 0;
  const selectedVpn = form ? vpns.find((v) => v.name === form.values.vpn) : undefined;
  const vpnOptions =
    form && form.values.vpn && !selectedVpn
      ? [...vpns.map((v) => v.name), form.values.vpn]
      : vpns.map((v) => v.name);
  const errors = folders
    .map((f) => (busy[f.name] ? null : (notice[f.name] ?? rowError(f))))
    .filter((e): e is string => !!e);

  return (
    <>
      <section data-component="NetworkFolders" className={sectionCls}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Network folders (through a VPN)
          </h2>
          <button
            type="button"
            onClick={openAdd}
            disabled={!vpnsLoaded || noVpn || (form?.mode === "add" && !form.saved)}
            className="rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Add network folder
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Folders on an office file server, read-only. These stay available to
          the agent when this page is closed. The VPN connects when the agent
          opens one and disconnects after its idle time.
        </p>

        {loadError ? <p className="mt-2 text-xs text-red-400">{loadError}</p> : null}

        {noVpn ? (
          <p data-component="NetworkFoldersNoVpn" className="mt-2 text-sm text-[var(--color-muted)]">
            Network folders need a VPN to the office. Add one in{" "}
            <Link href="/settings#in-out" className="text-[var(--color-accent)] underline">
              Settings → In&amp;Out → Private networks
            </Link>
            , then come back to add a folder.
          </p>
        ) : null}

        {loaded && !loadError && !noVpn && folders.length === 0 && !form ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No network folders yet — Add network folder to share one with the agent.
          </p>
        ) : null}

        {folders.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {folders.map((folder) => {
              const { status } = folder;
              const failed = !!status.error || status.last_check?.ok === false;
              const dot = status.mounted
                ? "bg-emerald-400"
                : failed
                  ? "bg-red-400"
                  : "bg-[var(--color-muted)]";
              const b = busy[folder.name];
              return (
                <li
                  key={folder.name}
                  data-network-folder={folder.id}
                  data-mounted={status.mounted ? "true" : "false"}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                >
                  <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{folder.name}</span>
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {displaySmbPath(folder.share_path)} · via{" "}
                      <span className="font-semibold">{folder.vpn}</span>
                    </span>
                  </span>
                  <span
                    data-vpn-chip={status.vpn_state}
                    className={`${chipCls} ${status.vpn_state === "connected" ? "text-emerald-400" : status.vpn_state === "error" ? "text-red-400" : ""}`}
                  >
                    {VPN_CHIP[status.vpn_state] ?? status.vpn_state}
                  </span>
                  {folder.trusted_for_import ? (
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">
                      Trusted for import
                    </span>
                  ) : null}
                  <button
                    type="button"
                    disabled={!!b}
                    onClick={() => void runTest(folder.name)}
                    className={btnCls}
                  >
                    {b === "test" ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    disabled={!!b}
                    onClick={() => openEdit(folder)}
                    className={btnCls}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={!!b}
                    onClick={() => setConfirmRemove(folder)}
                    className={`${btnCls} text-[var(--color-muted)]`}
                  >
                    {b === "remove" ? "Removing…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {errors.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {errors.map((e) => (
              <p
                key={e}
                role="alert"
                data-component="NetworkFolderError"
                className="rounded-lg border border-red-400/60 bg-red-500/10 px-3 py-2 text-xs text-red-300"
              >
                {e}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      {form ? (
        <section data-network-folder-form={form.mode} className={sectionCls}>
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            {form.mode === "add" ? "Add network folder" : `Edit network folder`}
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              <span>VPN connection</span>
              <select
                value={form.values.vpn}
                aria-label="VPN connection"
                onChange={(e) => setField("vpn", e.target.value)}
                className={inputCls}
              >
                {vpnOptions.map((name) => {
                  const v = vpns.find((x) => x.name === name);
                  const gateway = v
                    ? v.port && v.port !== 443
                      ? `${v.host}:${v.port}`
                      : v.host
                    : "not available";
                  return (
                    <option key={name} value={name}>
                      {name} — {gateway}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className={labelCls}>
              <span>Name shown to the agent</span>
              <input
                value={form.values.name}
                aria-label="Name shown to the agent"
                onChange={(e) => setField("name", e.target.value)}
                placeholder="Tender documents"
                className={inputCls}
              />
            </label>
          </div>
          <label className={`${labelCls} mt-3`}>
            <span>SMB path</span>
            <input
              value={form.values.share_path}
              aria-label="SMB path"
              onChange={(e) => setField("share_path", e.target.value)}
              placeholder="\\fs01.office.local\Projects\Tenders"
              autoComplete="off"
              spellCheck={false}
              className={inputCls}
            />
            <span className="block">
              Windows (\\server\share\folder) or smb://server/share/folder.
              Only this file server is sent through the VPN.
            </span>
          </label>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Share login (optional) — leave blank to use the VPN&apos;s login
          </p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={labelCls}>
              <span>Share username</span>
              <input
                value={form.values.share_username}
                aria-label="Share username"
                onChange={(e) => setField("share_username", e.target.value)}
                autoComplete="off"
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              <span>Share password</span>
              <input
                type="password"
                value={form.values.share_password}
                aria-label="Share password"
                onChange={(e) => setField("share_password", e.target.value)}
                placeholder={form.mode === "edit" ? "unchanged" : ""}
                autoComplete="new-password"
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              <span>Domain (optional)</span>
              <input
                value={form.values.share_domain}
                aria-label="Domain (optional)"
                onChange={(e) => setField("share_domain", e.target.value)}
                placeholder="OFFICE"
                autoComplete="off"
                className={inputCls}
              />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs" data-appmcp-deny="consent">
            <input
              type="checkbox"
              checked={form.values.trusted_for_import}
              onChange={(e) => setField("trusted_for_import", e.target.checked)}
            />
            Trusted for import (agent may copy files into Files without asking each time)
          </label>
          {formProblem ? (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {formProblem}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={!!saving}
              onClick={() => void save()}
              className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {saving === "saving" ? "Saving…" : saving === "testing" ? "Testing…" : "Save & test"}
            </button>
            <button
              type="button"
              disabled={!!saving}
              onClick={() => {
                setForm(null);
                setFormProblem(null);
                setResult(null);
              }}
              className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
            >
              {form.saved ? "Close" : "Cancel"}
            </button>
          </div>
          {result ? (
            <p
              data-component="NetworkFolderTestResult"
              data-ok={result.ok ? "true" : "false"}
              className={`mt-3 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm ${result.ok ? "" : "text-red-400"}`}
            >
              <span aria-hidden className={result.ok ? "text-emerald-400" : ""}>
                {result.ok ? "✓ " : "✗ "}
              </span>
              {result.text}
            </p>
          ) : null}
          {form.mode === "edit" && form.values.share_username.trim() ? (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Leave the password blank to keep the saved one.
            </p>
          ) : null}
        </section>
      ) : null}

      {confirmRemove ? (
        <ConfirmDialog
          title="Remove network folder?"
          body={`Remove ${confirmRemove.name} (${displaySmbPath(confirmRemove.share_path)})? Hermes unmounts it and the agent can no longer read it. Files already copied into Files stay; the VPN itself is not changed.`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const folder = confirmRemove;
            setConfirmRemove(null);
            return remove(folder);
          }}
        />
      ) : null}
    </>
  );
}
