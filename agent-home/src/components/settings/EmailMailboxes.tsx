"use client";

/**
 * Get ready item 7 / Settings → In&Out → Email (IMAP / SMTP): the signed-in
 * person's own mailboxes. Saved in the credential store as `email-imap`
 * entries private to that person; Hermes `/api/email/mailboxes` never
 * returns the password. "Save and test" saves, then logs into IMAP and SMTP
 * (no mail is sent). The install-wide poller toggle stays in Google accounts.
 */
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import en from "@/i18n/messages/en/email.json";
import zhHant from "@/i18n/messages/zh-Hant/email.json";
import type {
  EmailMailbox,
  EmailMailboxInput,
  EmailPreset,
  EmailSecurity,
  EmailServerSettings,
} from "@/types";

type Key = keyof typeof en;
type T = (key: Key, vars?: Record<string, string>) => string;

/** Local stand-in for the shared `useT` hook (not on develop yet): picks
 *  zh-Hant when the page language is Chinese, else English. */
export function useEmailT(): T {
  const [zh, setZh] = useState(false);
  useEffect(() => {
    setZh(document.documentElement.lang.toLowerCase().startsWith("zh"));
  }, []);
  return useCallback(
    (key, vars) => {
      const table: Record<string, string> = zh ? zhHant : en;
      let text = table[key] ?? en[key];
      for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, v);
      return text;
    },
    [zh],
  );
}

/** Same values as Hermes `email_mailboxes.PRESETS` (the GET reply wins). */
export const DEFAULT_PRESETS: Record<"gmail" | "outlook", EmailServerSettings> = {
  gmail: {
    imap_host: "imap.gmail.com", imap_port: 993, imap_security: "ssl",
    smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_security: "ssl",
  },
  outlook: {
    imap_host: "outlook.office365.com", imap_port: 993, imap_security: "ssl",
    smtp_host: "smtp.office365.com", smtp_port: 587, smtp_security: "starttls",
  },
};

interface FormValues {
  address: string;
  username: string;
  password: string;
  preset: EmailPreset;
  imap_host: string;
  imap_port: string;
  imap_security: EmailSecurity;
  smtp_host: string;
  smtp_port: string;
  smtp_security: EmailSecurity;
}

const EMPTY: FormValues = {
  address: "", username: "", password: "", preset: "other",
  imap_host: "", imap_port: "993", imap_security: "ssl",
  smtp_host: "", smtp_port: "465", smtp_security: "ssl",
};

function fromMailbox(m: EmailMailbox): FormValues {
  return {
    address: m.address, username: m.username, password: "", preset: m.preset,
    imap_host: m.imap_host, imap_port: String(m.imap_port ?? ""), imap_security: m.imap_security,
    smtp_host: m.smtp_host, smtp_port: String(m.smtp_port ?? ""), smtp_security: m.smtp_security,
  };
}

/** Form → request body, or the key of the problem to show. */
export function toInput(
  v: FormValues,
  editing: boolean,
): { body: EmailMailboxInput } | { problem: Key } {
  const required = [v.address, v.username, v.imap_host, v.smtp_host, v.imap_port, v.smtp_port];
  if (required.some((x) => !x.trim()) || !v.address.includes("@")) return { problem: "errRequired" };
  const ports = [Number(v.imap_port), Number(v.smtp_port)];
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) return { problem: "errPort" };
  if (!editing && !v.password) return { problem: "errPassword" };
  return {
    body: {
      username: v.username.trim(),
      ...(v.password ? { password: v.password } : {}),
      preset: v.preset,
      imap_host: v.imap_host.trim(), imap_port: ports[0], imap_security: v.imap_security,
      smtp_host: v.smtp_host.trim(), smtp_port: ports[1], smtp_security: v.smtp_security,
    },
  };
}

const inputCls =
  "w-full rounded border border-[var(--color-surface-2)] bg-transparent px-2 py-1 text-xs";
const labelCls = "block space-y-1 text-xs text-[var(--color-muted)]";
const btnCls =
  "rounded border border-[var(--color-surface-2)] px-2 py-1 text-xs font-semibold disabled:opacity-50";
const primaryBtnCls =
  "rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-black disabled:opacity-50";

const STATE_KEY: Record<EmailMailbox["state"], Key> = {
  working: "stateWorking",
  needs_attention: "stateNeedsAttention",
  untested: "stateUntested",
};
const STATE_COLOR: Record<EmailMailbox["state"], string> = {
  working: "text-[var(--color-accent)]",
  needs_attention: "text-red-400",
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

export function EmailMailboxes() {
  const t = useEmailT();
  const [mailboxes, setMailboxes] = useState<EmailMailbox[] | null>(null);
  const [presets, setPresets] = useState<Record<string, EmailServerSettings>>(DEFAULT_PRESETS);
  const [form, setForm] = useState<{ values: FormValues; editing: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/email/mailboxes", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const doc = (await res.json()) as {
        mailboxes: EmailMailbox[];
        presets?: Record<string, EmailServerSettings>;
      };
      setMailboxes(doc.mailboxes);
      if (doc.presets) setPresets(doc.presets);
      setError(null);
    } catch {
      setMailboxes((m) => m ?? []);
      setError(t("errLoad"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mailboxes && mailboxes.length === 0 && !form) setForm({ values: EMPTY, editing: false });
  }, [mailboxes, form]);

  const upsert = (m: EmailMailbox) =>
    setMailboxes((list) => [...(list ?? []).filter((x) => x.address !== m.address), m]);

  const setField = (field: keyof FormValues, value: string) =>
    setForm((f) => (f ? { ...f, values: { ...f.values, [field]: value } } : f));

  const choosePreset = (preset: EmailPreset) =>
    setForm((f) => {
      if (!f) return f;
      const p = preset === "other" ? null : presets[preset];
      const values: FormValues = { ...f.values, preset };
      if (p) {
        Object.assign(values, {
          imap_host: p.imap_host, imap_port: String(p.imap_port), imap_security: p.imap_security,
          smtp_host: p.smtp_host, smtp_port: String(p.smtp_port), smtp_security: p.smtp_security,
        });
      }
      if (p && !values.username) values.username = values.address;
      return { ...f, values };
    });

  async function saveAndTest() {
    if (!form || busy) return;
    const parsed = toInput(form.values, form.editing);
    if ("problem" in parsed) {
      setError(t(parsed.problem));
      return;
    }
    const address = form.values.address.trim().toLowerCase();
    setBusy(address);
    setError(null);
    try {
      const res = await fetch(`/api/email/mailboxes/${encodeURIComponent(address)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.body),
      });
      if (!res.ok) {
        setError(t("errSave", { reason: await readError(res) }));
        return;
      }
      upsert(((await res.json()) as { mailbox: EmailMailbox }).mailbox);
      setForm(null);
      await runTest(address);
    } finally {
      setBusy(null);
    }
  }

  async function runTest(address: string) {
    setBusy(address);
    try {
      const res = await fetch(`/api/email/mailboxes/${encodeURIComponent(address)}/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      upsert(((await res.json()) as { mailbox: EmailMailbox }).mailbox);
    } catch {
      setError(t("errTest"));
    } finally {
      setBusy(null);
    }
  }

  async function remove(address: string) {
    setBusy(address);
    try {
      const res = await fetch(`/api/email/mailboxes/${encodeURIComponent(address)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await readError(res));
      setMailboxes((list) => (list ?? []).filter((m) => m.address !== address));
      setRemoving(null);
    } catch {
      setError(t("errRemove"));
    } finally {
      setBusy(null);
    }
  }

  const v = form?.values;
  return (
    <section data-component="EmailMailboxes">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="text-xs text-[var(--color-muted)]">{t("description")}</p>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("perPerson")}</p>
      {error && <p role="alert" className="mb-2 text-xs text-red-400">{error}</p>}
      {mailboxes === null && <p className="text-xs text-[var(--color-muted)]">{t("loading")}</p>}
      {mailboxes && mailboxes.length > 0 && (
        <ul className="mb-3 space-y-2">
          {mailboxes.map((m) => (
            <MailboxRow
              key={m.address}
              mailbox={m}
              t={t}
              busy={busy}
              onTest={() => void runTest(m.address)}
              onEdit={() => setForm({ values: fromMailbox(m), editing: true })}
              onRemove={() => setRemoving(m.address)}
            />
          ))}
        </ul>
      )}
      {mailboxes && !form && (
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
          data-email-form
          className="space-y-3 rounded border border-[var(--color-surface-2)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAndTest();
          }}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={t("preset")}>
            <span className="text-[var(--color-muted)]">{t("preset")}</span>
            {(["gmail", "outlook", "other"] as const).map((p) => (
              <button
                key={p}
                type="button"
                data-preset={p}
                aria-pressed={v.preset === p}
                className={`${btnCls} ${v.preset === p ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
                onClick={() => choosePreset(p)}
              >
                {t(p === "gmail" ? "presetGmail" : p === "outlook" ? "presetOutlook" : "presetOther")}
              </button>
            ))}
          </div>
          {v.preset !== "other" && (
            <p className="text-xs text-[var(--color-muted)]">{t("presetHint")}</p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <label className={labelCls}>
              <span>{t("address")}</span>
              <input
                className={inputCls}
                type="email"
                autoComplete="email"
                placeholder="info@yourcompany.com"
                value={v.address}
                disabled={form.editing}
                onChange={(e) => setField("address", e.target.value)}
              />
            </label>
            <label className={labelCls}>
              <span>{t("username")}</span>
              <input
                className={inputCls}
                autoComplete="username"
                value={v.username}
                onChange={(e) => setField("username", e.target.value)}
              />
            </label>
            <ServerField t={t} side="imap" label={t("incoming")} placeholder="imap.yourmail.com" v={v} setField={setField} />
            <ServerField t={t} side="smtp" label={t("outgoing")} placeholder="smtp.yourmail.com" v={v} setField={setField} />
            <label className={labelCls}>
              <span>{t("password")}</span>
              <input
                className={inputCls}
                type="password"
                aria-label={t("password")}
                autoComplete="new-password"
                value={v.password}
                placeholder={form.editing ? "••••••••" : ""}
                onChange={(e) => setField("password", e.target.value)}
              />
              {form.editing && <span className="block">{t("passwordKept")}</span>}
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryBtnCls} disabled={!!busy} aria-busy={!!busy}>
              {busy ? t("testing") : t("saveTest")}
            </button>
            {(mailboxes?.length ?? 0) > 0 && (
              <button type="button" className={btnCls} disabled={!!busy} onClick={() => setForm(null)}>
                {t("cancel")}
              </button>
            )}
          </div>
        </form>
      )}
      {removing && (
        <ConfirmDialog
          title={t("removeTitle", { address: removing })}
          body={t("removeBody")}
          confirmLabel={t("remove")}
          cancelLabel={t("cancel")}
          busy={busy === removing}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function ServerField({
  t, side, label, placeholder, v, setField,
}: {
  t: T;
  side: "imap" | "smtp";
  label: string;
  placeholder: string;
  v: FormValues;
  setField: (field: keyof FormValues, value: string) => void;
}) {
  return (
    <div data-component="ServerField" className={labelCls}>
      <span>{label}</span>
      <div className="flex gap-2">
        <input
          aria-label={label}
          className={`${inputCls} min-w-0 flex-1`}
          placeholder={placeholder}
          value={v[`${side}_host`]}
          onChange={(e) => setField(`${side}_host`, e.target.value)}
        />
        <input
          aria-label={`${label} ${t("port")}`}
          className={`${inputCls} w-16 shrink-0`}
          inputMode="numeric"
          value={v[`${side}_port`]}
          onChange={(e) => setField(`${side}_port`, e.target.value)}
        />
        <select
          aria-label={`${label} ${t("security")}`}
          className={`${inputCls} w-28 shrink-0 bg-[var(--color-surface)]`}
          value={v[`${side}_security`]}
          onChange={(e) => setField(`${side}_security`, e.target.value)}
        >
          <option value="ssl">{t("securitySsl")}</option>
          <option value="starttls">{t("securityStarttls")}</option>
        </select>
      </div>
    </div>
  );
}

function MailboxRow({
  mailbox: m, t, busy, onTest, onEdit, onRemove,
}: {
  mailbox: EmailMailbox;
  t: T;
  busy: string | null;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const test = m.last_test;
  const testing = busy === m.address;
  return (
    <li data-component="MailboxRow" className="rounded border border-[var(--color-surface-2)] p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{m.address}</span>
        <span data-email-state className={`shrink-0 ${STATE_COLOR[m.state]}`}>{t(STATE_KEY[m.state])}</span>
      </div>
      <p className="mt-1 break-all text-[var(--color-muted)]">
        IMAP {m.imap_host}:{m.imap_port} · SMTP {m.smtp_host}:{m.smtp_port}
      </p>
      {test && (
        <>
          <p className={`mt-1 ${test.imap.ok ? "text-[var(--color-muted)]" : "text-red-400"}`}>
            {test.imap.ok ? t("imapOk") : t("imapFail", { reason: test.imap.error ?? "" })}
          </p>
          <p className={`mt-1 ${test.smtp.ok ? "text-[var(--color-muted)]" : "text-red-400"}`}>
            {test.smtp.ok ? t("smtpOk") : t("smtpFail", { reason: test.smtp.error ?? "" })}
          </p>
        </>
      )}
      {m.last_poll?.ok === false && m.last_poll.error && (
        <p className="mt-1 text-red-400">{t("readProblem", { reason: m.last_poll.error })}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btnCls} disabled={!!busy} aria-busy={testing} onClick={onTest}>
          {testing ? t("testing") : t("test")}
        </button>
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
