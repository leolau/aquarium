"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pill } from "@/components/ui/Pill";
import { Spinner } from "@/components/ui/Spinner";
import type {
  McpOAuthFlowState,
  McpServerTestResult,
  PersonalMcpCatalogEntry,
  PersonalMcpServer,
  PersonalMcpServersResponse,
} from "@/types";

import { useExtraToolsT } from "./extraToolsStrings";

/**
 * "Your own tools" (Get ready item 8): the signed-in person's own MCP
 * servers. Only that person sees, tests or uses them; the server enforces it
 * (`/api/mcp/personal`). Self-contained so the Get ready checklist can show
 * the same block inline. `onCount` reports how many servers the person has.
 */

const API = "/api/tools/personal-mcp";
const inputCls =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";
const btnCls =
  "rounded-lg bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const primaryBtnCls =
  "rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

type FormValues = { name: string; url: string; headerName: string; headerValue: string; oauth: boolean };
const EMPTY_FORM: FormValues = { name: "", url: "", headerName: "", headerValue: "", oauth: false };

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

function serverPath(name: string, rest = ""): string {
  return `${API}/${encodeURIComponent(name)}${rest}`;
}

export function PersonalMcpServers({ onCount }: { onCount?: (count: number) => void }) {
  const t = useExtraToolsT();
  const [data, setData] = useState<PersonalMcpServersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<Record<string, "test" | "remove" | null>>({});
  const [results, setResults] = useState<Record<string, McpServerTestResult | null>>({});
  const [removing, setRemoving] = useState<PersonalMcpServer | null>(null);
  const [catalog, setCatalog] = useState<PersonalMcpCatalogEntry[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await call<PersonalMcpServersResponse>(API);
      setData(next);
      setLoadError(null);
      onCount?.(next.servers.length);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTest(name: string) {
    if (busy[name]) return;
    setBusy((b) => ({ ...b, [name]: "test" }));
    setResults((r) => ({ ...r, [name]: null }));
    try {
      const result = await call<McpServerTestResult>(serverPath(name, "/test"), {
        method: "POST",
        json: {},
      });
      setResults((r) => ({ ...r, [name]: result }));
    } catch (err) {
      setResults((r) => ({
        ...r,
        [name]: { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setBusy((b) => ({ ...b, [name]: null }));
    }
  }

  async function save(values: FormValues) {
    if (saving) return;
    setSaving(true);
    setFormError(null);
    const headers =
      values.headerName.trim() && values.headerValue.trim()
        ? { [values.headerName.trim()]: values.headerValue.trim() }
        : undefined;
    try {
      const saved = await call<PersonalMcpServer>(API, {
        method: "POST",
        json: {
          name: values.name.trim(),
          url: values.url.trim(),
          ...(headers ? { headers } : {}),
          ...(values.oauth ? { auth: "oauth" } : {}),
        },
      });
      setForm(null);
      await load();
      setCatalog(null);
      setCatalogOpen(false);
      if (saved.auth !== "oauth") await runTest(saved.name);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    const target = removing;
    if (!target || busy[target.name]) return;
    setBusy((b) => ({ ...b, [target.name]: "remove" }));
    try {
      await call(serverPath(target.name), { method: "DELETE" });
      setResults((r) => ({ ...r, [target.name]: null }));
      setCatalog(null);
      setCatalogOpen(false);
      await load();
    } catch (err) {
      setResults((r) => ({
        ...r,
        [target.name]: { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setBusy((b) => ({ ...b, [target.name]: null }));
      setRemoving(null);
    }
  }

  async function toggleCatalog() {
    const open = !catalogOpen;
    setCatalogOpen(open);
    if (open && catalog === null) {
      try {
        setCatalog((await call<{ entries: PersonalMcpCatalogEntry[] }>(`${API}/catalog`)).entries);
      } catch {
        setCatalog([]);
      }
    }
  }

  const servers = data?.servers ?? [];
  const atLimit = data ? servers.length >= data.limit : false;

  return (
    <section data-component="PersonalMcpServers" className="mb-6 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="text-xs text-[var(--color-muted)]">{t("intro")}</p>
      </div>

      {loadError ? (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {t("loadError", { error: loadError })}
        </p>
      ) : data === null ? (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Spinner /> {t("loading")}
        </p>
      ) : !data.configured ? (
        <p className="text-sm text-[var(--color-muted)]">{t("notConfigured")}</p>
      ) : (
        <>
          {servers.length === 0 ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <p className="text-xs text-[var(--color-muted)]">{t("empty")}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {servers.map((s) => (
                <ServerRow
                  key={s.name}
                  server={s}
                  busy={busy[s.name] ?? null}
                  result={results[s.name] ?? null}
                  onTest={() => void runTest(s.name)}
                  onRemove={() => setRemoving(s)}
                  onSignedIn={() => void load()}
                />
              ))}
            </ul>
          )}

          {form ? (
            <AddForm
              values={form}
              onChange={setForm}
              saving={saving}
              error={formError}
              onSave={() => void save(form)}
              onCancel={() => {
                setForm(null);
                setFormError(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryBtnCls}
                disabled={atLimit}
                onClick={() => setForm({ ...EMPTY_FORM })}
              >
                {t("add")}
              </button>
              <button type="button" className={btnCls} onClick={() => void toggleCatalog()}>
                {catalogOpen ? t("hideCatalog") : t("catalog")}
              </button>
            </div>
          )}
          {atLimit ? (
            <p className="text-xs text-[var(--color-muted)]">{t("limit", { limit: data.limit })}</p>
          ) : null}

          {catalogOpen && !form ? (
            <CatalogList
              entries={catalog}
              onPick={(e) =>
                setForm({ ...EMPTY_FORM, name: e.name, url: e.url, oauth: e.auth === "oauth" })
              }
              disabled={atLimit}
            />
          ) : null}

          <p className="text-xs text-[var(--color-muted)]">
            {t("onlyYou")} {t("nextChat")}
          </p>
        </>
      )}

      {removing ? (
        <ConfirmDialog
          title={t("removeTitle", { name: removing.name })}
          body={t("removeBody")}
          confirmLabel={t("remove")}
          cancelLabel={t("cancel")}
          busy={busy[removing.name] === "remove"}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}

function ServerRow({
  server,
  busy,
  result,
  onTest,
  onRemove,
  onSignedIn,
}: {
  server: PersonalMcpServer;
  busy: "test" | "remove" | null;
  result: McpServerTestResult | null;
  onTest: () => void;
  onRemove: () => void;
  onSignedIn: () => void;
}) {
  const t = useExtraToolsT();
  const needsSignIn = server.auth === "oauth" && !server.oauth_token_present;
  return (
    <li
      data-component="PersonalMcpServerRow"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{server.name}</span>
        {server.auth === "oauth" ? (
          <Pill tone={needsSignIn ? "warning" : "success"}>
            {needsSignIn ? t("needsSignIn") : t("signedIn")}
          </Pill>
        ) : null}
        {server.header_names.length > 0 ? (
          <Pill tone="muted">{t("keySaved", { names: server.header_names.join(", ") })}</Pill>
        ) : null}
      </div>
      <p className="mt-1 truncate text-xs text-[var(--color-muted)]">{server.url}</p>
      {result ? (
        <p
          role="status"
          className={`mt-2 break-words text-xs ${result.ok ? "text-emerald-400" : "text-red-400"}`}
        >
          {result.ok
            ? t("testOk", { count: result.tools.length })
            : t("testFail", { error: result.error ?? "" })}
          {result.ok && result.tools.length > 0 ? (
            <span className="block text-[var(--color-muted)]">
              {result.tools.map((x) => x.name).join(", ")}
            </span>
          ) : null}
        </p>
      ) : null}
      {server.auth === "oauth" ? <SignIn name={server.name} onDone={onSignedIn} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btnCls} disabled={busy !== null} onClick={onTest}>
          {busy === "test" ? (
            <span className="inline-flex items-center gap-1">
              <Spinner /> {t("testing")}
            </span>
          ) : (
            t("test")
          )}
        </button>
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 disabled:opacity-50"
          disabled={busy !== null}
          onClick={onRemove}
        >
          {t("remove")}
        </button>
      </div>
    </li>
  );
}

function SignIn({ name, onDone }: { name: string; onDone: () => void }) {
  const t = useExtraToolsT();
  const [flow, setFlow] = useState<McpOAuthFlowState | null>(null);
  const [redirect, setRedirect] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function poll(): Promise<void> {
    try {
      const state = await call<McpOAuthFlowState>(serverPath(name, "/oauth/status"));
      setFlow(state);
      if (state.status === "starting" || state.status === "waiting_user") {
        timer.current = setTimeout(() => void poll(), 1500);
      } else if (state.status === "success") {
        onDone();
      }
    } catch {
      timer.current = setTimeout(() => void poll(), 1500);
    }
  }

  async function start() {
    if (flow && (flow.status === "starting" || flow.status === "waiting_user")) return;
    setNote(null);
    setFlow({ status: "starting" });
    try {
      setFlow(await call<McpOAuthFlowState>(serverPath(name, "/oauth/start"), { method: "POST", json: {} }));
      void poll();
    } catch (err) {
      setFlow(null);
      setNote(err instanceof Error ? err.message : String(err));
    }
  }

  async function finish() {
    if (sending || !redirect.trim()) return;
    setSending(true);
    setNote(null);
    try {
      await call(serverPath(name, "/oauth/redirect"), { method: "POST", json: { url: redirect.trim() } });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    clearTimeout(timer.current);
    await call(serverPath(name, "/oauth/cancel"), { method: "POST", json: {} }).catch(() => {});
    setFlow(null);
  }

  const active = flow?.status === "starting" || flow?.status === "waiting_user";
  return (
    <div data-component="PersonalMcpSignIn" className="mt-3 space-y-2">
      {!active ? (
        <button type="button" className={btnCls} onClick={() => void start()}>
          {t("signIn")}
        </button>
      ) : null}
      {flow?.status === "starting" ? (
        <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <Spinner /> {t("starting")}
        </p>
      ) : null}
      {flow?.status === "waiting_user" && flow.authorization_url ? (
        <div className="space-y-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs">
          <a
            href={flow.authorization_url}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-[var(--color-accent)] underline"
          >
            {t("openLink")}
          </a>
          <p className="text-[var(--color-muted)]">{t("pasteHint")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={redirect}
              onChange={(e) => setRedirect(e.target.value)}
              placeholder={t("pastePh")}
              className={`${inputCls} min-w-0 flex-1 font-mono text-xs`}
            />
            <button
              type="button"
              className={primaryBtnCls}
              disabled={sending || !redirect.trim()}
              onClick={() => void finish()}
            >
              {sending ? t("finishing") : t("finish")}
            </button>
          </div>
        </div>
      ) : null}
      {active ? (
        <button type="button" className={btnCls} onClick={() => void cancel()}>
          {t("cancelSignIn")}
        </button>
      ) : null}
      {flow?.status === "success" ? <p className="text-xs text-emerald-400">{t("signInDone")}</p> : null}
      {flow?.status === "error" ? (
        <p className="text-xs text-red-400">{t("signInFailed", { error: flow.error ?? "" })}</p>
      ) : null}
      {note ? <p className="text-xs text-red-400">{note}</p> : null}
    </div>
  );
}

function AddForm({
  values,
  onChange,
  saving,
  error,
  onSave,
  onCancel,
}: {
  values: FormValues;
  onChange: (v: FormValues) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useExtraToolsT();
  const set = (k: keyof FormValues, v: string | boolean) => onChange({ ...values, [k]: v });
  return (
    <form
      data-component="PersonalMcpAddForm"
      className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          <span>{t("name")}</span>
          <input
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("namePh")}
            className={inputCls}
            autoCapitalize="none"
          />
          <span className="block">{t("nameHint")}</span>
        </label>
        <label className={labelCls}>
          <span>{t("url")}</span>
          <input
            value={values.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder={t("urlPh")}
            className={inputCls}
            inputMode="url"
            autoCapitalize="none"
          />
        </label>
        {!values.oauth ? (
          <>
            <label className={labelCls}>
              <span>{t("headerName")}</span>
              <input
                value={values.headerName}
                onChange={(e) => set("headerName", e.target.value)}
                placeholder={t("headerNamePh")}
                className={inputCls}
                autoCapitalize="none"
              />
            </label>
            <label className={labelCls}>
              <span>{t("headerValue")}</span>
              <input
                type="password"
                value={values.headerValue}
                onChange={(e) => set("headerValue", e.target.value)}
                placeholder={t("headerValuePh")}
                className={inputCls}
                autoComplete="off"
              />
            </label>
          </>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={values.oauth} onChange={(e) => set("oauth", e.target.checked)} />
        {t("useSignIn")}
      </label>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className={primaryBtnCls}
          disabled={saving || !values.name.trim() || !values.url.trim()}
        >
          {saving ? (
            <span className="inline-flex items-center gap-1">
              <Spinner /> {t("saving")}
            </span>
          ) : (
            t("save")
          )}
        </button>
        <button type="button" className={btnCls} disabled={saving} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function CatalogList({
  entries,
  onPick,
  disabled,
}: {
  entries: PersonalMcpCatalogEntry[] | null;
  onPick: (e: PersonalMcpCatalogEntry) => void;
  disabled: boolean;
}) {
  const t = useExtraToolsT();
  if (entries === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (entries.length === 0) {
    return <p className="text-xs text-[var(--color-muted)]">{t("catalogEmpty")}</p>;
  }
  return (
    <ul data-component="PersonalMcpCatalog" className="grid gap-2 sm:grid-cols-2">
      {entries.map((e) => (
        <li
          key={e.name}
          className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{e.name}</p>
            <p className="text-xs text-[var(--color-muted)]">{e.description}</p>
          </div>
          {e.added ? (
            <Pill tone="success">{t("added")}</Pill>
          ) : (
            <button type="button" className={btnCls} disabled={disabled} onClick={() => onPick(e)}>
              {t("addThis")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
