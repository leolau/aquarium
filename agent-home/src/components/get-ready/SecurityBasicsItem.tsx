"use client";

/**
 * Settings → Get ready → item 11 "Security basics" (owner/admin).
 *
 * A read-only list: HTTPS certificate, SSH key-only sign-in, automatic
 * security updates, open ports, the `aquarium doctor` health check, the
 * assistant's own Linux user and owner two-factor login. Each failed check
 * gets a plain fix; server commands only appear under "Show me how". Nothing
 * here changes a server setting.
 */
import { useCallback, useEffect, useState } from "react";

import { Spinner } from "@/components/ui/Spinner";
import type { SecurityBasicsResult, SecurityCheck } from "@/lib/api/security-basics";

import { type Lang, type Translate, useSecurityBasicsT } from "./securityBasicsT";

type Row = {
  id: string;
  tone: "ok" | "warn" | "unknown" | "muted";
  text: string;
  extra: string[];
  fix: string[];
  how: string | null;
  howList: { text: string; fix: string }[];
};

const LABEL_KEY = {
  ssh: "label.ssh",
  updates: "label.updates",
  ports: "label.ports",
  doctor: "label.doctor",
} as const;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function formatDate(iso: string, lang: Lang): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "zh-Hant" ? "zh-Hant" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function formatWhen(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === "zh-Hant" ? "zh-Hant" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Plain-words line(s) for one check. */
export function describe(check: SecurityCheck, t: Translate, lang: Lang): Row {
  const f = check.facts ?? {};
  const row: Row = {
    id: check.id,
    tone: check.status === "ok" ? "ok" : check.status === "attention" ? "warn" : check.status === "unavailable" ? "muted" : "unknown",
    text: "",
    extra: [],
    fix: [],
    how: null,
    howList: [],
  };
  const reason = str(f.reason);
  if (reason.startsWith("helper_") && check.id in LABEL_KEY) {
    row.text = t("cantCheck", { label: t(LABEL_KEY[check.id as keyof typeof LABEL_KEY]) });
    row.fix = [t("cantCheckFix")];
    return row;
  }
  switch (check.id) {
    case "tls": {
      if (reason === "no_domain") {
        row.text = t("tls.noDomain");
        row.fix = [t("tls.noDomainFix")];
        break;
      }
      const certs = Array.isArray(f.certificates) ? (f.certificates as Record<string, unknown>[]) : [];
      const line = (c: Record<string, unknown>) =>
        c.error === "invalid"
          ? t("tls.invalid", { domain: str(c.domain) })
          : c.error === "unreachable"
            ? t("tls.unreachable", { domain: str(c.domain) })
            : t("tls.soon", { domain: str(c.domain), days: num(c.days_left), date: formatDate(str(c.valid_until), lang) });
      const bad = certs.filter((c) => !c.ok);
      if (bad.length) {
        row.text = line(bad[0]);
        row.extra = bad.slice(1).map(line);
        row.fix = [t("tls.fix")];
        row.how = t("tls.how");
      } else {
        const first = certs.map((c) => str(c.valid_until)).sort()[0] ?? "";
        row.text =
          certs.length > 1
            ? t("tls.okMany", { count: certs.length, date: formatDate(first, lang) })
            : t("tls.ok", { date: formatDate(first, lang) });
      }
      break;
    }
    case "ssh": {
      if (reason === "sshd_unreadable") row.text = t("ssh.unreadable");
      else if (f.installed === false) row.text = t("ssh.none");
      else if (check.status === "ok") row.text = t("ssh.ok");
      else {
        const lines = [
          f.password_login ? t("ssh.password") : "",
          f.root_password_login ? t("ssh.root") : "",
          f.empty_passwords ? t("ssh.empty") : "",
        ].filter(Boolean);
        row.text = lines[0] ?? t("ssh.password");
        row.extra = lines.slice(1);
        const keys = num(f.authorized_keys);
        row.fix = [t("ssh.fix"), keys > 0 ? t("ssh.keys", { count: keys }) : t("ssh.noKeys")];
        row.how = t("ssh.how");
      }
      break;
    }
    case "updates":
      if (check.status === "ok") row.text = t("updates.ok");
      else {
        row.text = t("updates.off");
        row.fix = [t("updates.fix")];
        row.how = t("updates.how");
      }
      break;
    case "ports": {
      if (reason === "ports_unreadable") {
        row.text = t("ports.unreadable");
        break;
      }
      const extra = Array.isArray(f.extra) ? (f.extra as Record<string, unknown>[]) : [];
      if (!extra.length) row.text = t("ports.ok");
      else {
        const list = extra
          .map((p) => (p.bypasses_firewall ? t("ports.docker", { port: num(p.port) }) : String(num(p.port))))
          .join(", ");
        row.text = t("ports.extra", { ports: list });
        row.fix = [t("ports.fix")];
        row.how = t("ports.how");
      }
      if (f.firewall_on === false) row.extra.push(t("ports.firewallOff"));
      break;
    }
    case "doctor": {
      const byReason = {
        doctor_missing: ["doctor.missing", "doctor.missingFix", null],
        doctor_old: ["doctor.old", "doctor.oldFix", "doctor.oldHow"],
        doctor_timeout: ["doctor.timeout", "doctor.timeoutFix", null],
        doctor_untrusted: ["doctor.untrusted", "doctor.untrustedFix", null],
      } as const;
      if (reason in byReason) {
        const [text, fix, how] = byReason[reason as keyof typeof byReason];
        row.text = t(text);
        row.fix = [t(fix)];
        row.how = how ? t(how) : null;
        break;
      }
      const problems = Array.isArray(f.problems) ? (f.problems as Record<string, unknown>[]) : [];
      row.howList = problems.map((p) => ({ text: str(p.text), fix: str(p.fix) }));
      if (check.status === "ok") {
        row.text = num(f.warned) > 0 ? t("doctor.okWarn", { warned: num(f.warned) }) : t("doctor.ok", { total: num(f.total) });
      } else {
        row.text = t("doctor.failed", { failed: num(f.failed) });
        row.fix = [t("doctor.fix")];
      }
      break;
    }
    case "tools_user":
      if (check.status === "ok") row.text = t("tools_user.ok", { user: str(f.run_as) });
      else {
        row.text = t("tools_user.off");
        row.fix = [t("tools_user.fix")];
        row.how = t("tools_user.how");
      }
      break;
    case "two_factor":
      if (check.status === "unavailable") row.text = t("two_factor.unavailable");
      else if (check.status === "ok") row.text = t("two_factor.ok");
      else if (check.status === "attention") {
        row.text = t("two_factor.off");
        row.fix = [t("two_factor.fix")];
      } else row.text = t("two_factor.unknown");
      break;
  }
  return row;
}

const ICON: Record<Row["tone"], { glyph: string; cls: string }> = {
  ok: { glyph: "✓", cls: "text-emerald-400" },
  warn: { glyph: "!", cls: "text-[var(--color-warn-text)]" },
  unknown: { glyph: "?", cls: "text-[var(--color-muted)]" },
  muted: { glyph: "–", cls: "text-[var(--color-muted)]" },
};

function StatusPill({ status, t }: { status: SecurityBasicsResult["status"]; t: Translate }) {
  const cls =
    status === "done"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "attention"
        ? "bg-amber-500/15 text-[var(--color-warn-text)]"
        : "bg-[var(--color-surface-2)] text-[var(--color-fg)]";
  return (
    <span data-status={status} className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>
      {t(`status.${status}`)}
    </span>
  );
}

function CheckRow({ row, t }: { row: Row; t: Translate }) {
  const [open, setOpen] = useState(false);
  const icon = ICON[row.tone];
  const hasHow = Boolean(row.how) || row.howList.length > 0;
  return (
    <li data-check={row.id} data-tone={row.tone} className="flex gap-2 text-sm">
      <span aria-hidden className={`w-4 shrink-0 text-center font-semibold ${icon.cls}`}>
        {icon.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className={row.tone === "warn" ? "text-[var(--color-warn-text)]" : ""}>{row.text}</p>
        {row.extra.map((line) => (
          <p key={line} className="text-xs text-[var(--color-muted)]">
            {line}
          </p>
        ))}
        {row.fix.map((line) => (
          <p key={line} className="mt-0.5 text-xs text-[var(--color-muted)]">
            {line}
          </p>
        ))}
        {hasHow ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 text-xs text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {open ? t("hideHow") : `${t("showHow")} →`}
          </button>
        ) : null}
        {open && row.how ? (
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs">
            {row.how}
          </pre>
        ) : null}
        {open && row.howList.length ? (
          <ul className="mt-1 space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs">
            {row.howList.map((p) => (
              <li key={p.text}>
                <span className="font-medium">{p.text}</span>
                {p.fix ? <span className="block font-mono text-[var(--color-muted)]">{p.fix}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export function SecurityBasicsItem({
  number = 11,
  initial,
  lang,
  defaultOpen = false,
}: {
  number?: number;
  /** Server-loaded last result; undefined = load it here. */
  initial?: SecurityBasicsResult | null;
  lang?: Lang;
  defaultOpen?: boolean;
}) {
  const { t, lang: current } = useSecurityBasicsT(lang);
  const [result, setResult] = useState<SecurityBasicsResult | null>(initial ?? null);
  const [open, setOpen] = useState(defaultOpen);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initial !== undefined) return;
    let gone = false;
    fetch("/api/security-basics")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as SecurityBasicsResult;
        if (!gone) setResult(data);
      })
      .catch(() => {
        if (!gone) setMessage(t("loadError"));
      });
    return () => {
      gone = true;
    };
  }, [initial, t]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/security-basics/test", { method: "POST" });
      if (res.status === 409) setMessage(t("busy"));
      else if (!res.ok) setMessage(t("error"));
      else setResult((await res.json()) as SecurityBasicsResult);
    } catch {
      setMessage(t("error"));
    } finally {
      setTesting(false);
    }
  }, [t]);

  const status = result?.status ?? "not_started";
  const rows = (result?.checks ?? []).map((c) => describe(c, t, current));
  const firstProblem = rows.find((r) => r.tone === "warn");
  const busy = testing || Boolean(result?.running);
  const helperIssue = result && result.checked_at && result.helper && result.helper !== "ok" ? result.helper : null;

  const summary = !result?.checked_at
    ? t("summaryNotTested")
    : firstProblem
      ? t("summaryWithProblem", {
          passed: result.passed,
          total: result.total,
          text: firstProblem.text,
        })
      : t("summary", { passed: result.passed, total: result.total });

  const badge =
    status === "done"
      ? "bg-emerald-500 text-white"
      : status === "attention"
        ? "bg-amber-500 text-black"
        : "bg-[var(--color-surface-2)] text-[var(--color-fg)]";

  return (
    <section
      data-component="SecurityBasicsItem"
      data-item={number}
      className={`rounded-2xl border bg-[var(--color-surface)] p-4 ${open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
    >
      <div className="flex gap-3">
        <span
          aria-hidden
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${badge}`}
        >
          {status === "done" ? "✓" : number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{t("title")}</h3>
            <StatusPill status={status} t={t} />
            <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
              {t("required")}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{summary}</p>
          <p className="text-xs text-[var(--color-muted)]">
            {result?.checked_at ? t("lastTest", { time: formatWhen(result.checked_at, current) }) : t("notTested")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${open ? "border border-[var(--color-border)] bg-[var(--color-surface-2)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"}`}
            >
              {open ? t("close") : t("setUp")}
            </button>
            <button
              type="button"
              onClick={runTest}
              disabled={busy}
              aria-busy={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            >
              {busy ? <Spinner /> : null}
              {busy ? t("testing") : t("test")}
            </button>
          </div>
          {busy ? (
            <p role="status" className="mt-2 text-xs text-[var(--color-muted)]">
              {t("testingNote")}
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="mt-2 text-xs text-[var(--color-warn-text)]">
              {message}
            </p>
          ) : null}
          {!open && firstProblem ? (
            <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--color-warn-text)]">
              ! {t("firstProblem", { text: firstProblem.text })}
            </p>
          ) : null}
        </div>
      </div>
      {open ? (
        <div data-section="security-basics-panel" className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs text-[var(--color-muted)]">{t("readOnly")}</p>
          {helperIssue ? <HelperNotice reason={helperIssue} t={t} /> : null}
          {rows.length ? (
            <ul className="space-y-2">
              {rows.map((row) => (
                <CheckRow key={row.id} row={row} t={t} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">{t("notTested")}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function HelperNotice({ reason, t }: { reason: string; t: Translate }) {
  const [open, setOpen] = useState(false);
  const key = (["missing", "refused", "busy", "timeout", "bad_output"].includes(reason)
    ? `helper.${reason}`
    : "helper.bad_output") as "helper.missing";
  const install = reason === "missing" || reason === "refused";
  return (
    <div data-helper={reason} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <p className="text-[var(--color-warn-text)]">{t(key)}</p>
      {install ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {open ? t("hideHow") : `${t("showHow")} →`}
          </button>
          {open ? (
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{t("helper.how")}</pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
