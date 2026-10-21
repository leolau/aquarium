"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Spinner } from "@/components/ui/Spinner";
import {
  useGoogleClientT,
  type GoogleClientKey,
  type GoogleClientT,
} from "@/components/settings/googleClientStrings";
import type {
  GoogleClientCheck,
  GoogleClientSaveResult,
  GoogleClientStatus,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

type TickStep = "1" | "2" | "3" | "4" | "5";
const TICK_STEPS: TickStep[] = ["1", "2", "3", "4", "5"];

const CONSOLE = {
  project: "https://console.cloud.google.com/projectcreate",
  apis: "https://console.cloud.google.com/apis/library",
  branding: "https://console.cloud.google.com/auth/branding",
  scopes: "https://console.cloud.google.com/auth/scopes",
  client: "https://console.cloud.google.com/auth/clients/create",
};

type Message = { tone: "ok" | "bad"; key: GoogleClientKey };

function checkMessage(check: GoogleClientCheck): Message {
  if (check === "ok") return { tone: "ok", key: "ok" };
  return { tone: "bad", key: `err_${check}` as GoogleClientKey };
}

async function errorKey(res: Response): Promise<GoogleClientKey> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const key = `err_${String(body.detail ?? "")}`;
    if (key in KNOWN_ERRORS) return key as GoogleClientKey;
  } catch {
    /* fall through */
  }
  return "err_generic";
}

const KNOWN_ERRORS: Record<string, true> = {
  err_client_exists: true,
  err_not_json: true,
  err_not_client_file: true,
  err_too_large: true,
  err_bad_client_id: true,
  err_missing_secret: true,
};

function CopyBox({
  value,
  label,
  multiline = false,
  t,
}: {
  value: string;
  label?: string;
  multiline?: boolean;
  t: GoogleClientT;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked: the value stays selectable */
    }
  };
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-[var(--color-muted)]">{label}</span>}
      <div
        className={`flex gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-2.5 pr-1 ${multiline ? "items-start" : "items-center"}`}
      >
        <code
          className={`min-w-0 flex-1 break-all py-1 font-mono text-xs ${multiline ? "whitespace-pre-wrap" : ""}`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="min-h-9 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 text-xs"
        >
          {copied ? t("copied") : multiline ? t("copyAll") : t("copy")}
        </button>
      </div>
    </div>
  );
}

function ConsoleLink({ href, t }: { href: string; t: GoogleClientT }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-1 inline-block text-xs text-[var(--color-accent)]"
    >
      {t("openGoogleCloud")}
    </a>
  );
}

function Step({
  n,
  title,
  done,
  onToggle,
  disabled,
  t,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  onToggle?: () => unknown;
  disabled?: boolean;
  t: GoogleClientT;
  children: ReactNode;
}) {
  return (
    <li
      data-step={n}
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 ${done ? "opacity-80" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={t("markDone", { n })}
          onClick={onToggle}
          disabled={disabled || !onToggle}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-sm ${done ? "border-emerald-500 bg-emerald-500 text-emerald-950" : "border-[var(--color-border)]"}`}
        >
          {done ? "✓" : ""}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {n}. {title}
          </p>
          {children}
        </div>
      </div>
    </li>
  );
}

/**
 * Get ready item 4, step A (owner only): register this Aquarium with Google
 * once. Steps 1–5 happen in Google Cloud, so the owner ticks them; step 6
 * saves the client on the server and asks Google whether it is accepted.
 * Step B — each person connecting their own account — is Connected accounts.
 */
export function GoogleClientSetup() {
  const t = useGoogleClientT();
  const [status, setStatus] = useState<GoogleClientStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/google-client")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as GoogleClientStatus;
        if (live) setStatus(data);
      })
      .catch(() => live && setLoadFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback(
    async (n: TickStep) => {
      if (!status) return;
      const next = !status.steps[n];
      setStatus({ ...status, steps: { ...status.steps, [n]: next } });
      try {
        const res = await fetch("/api/google-client/steps", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ steps: { [n]: next } }),
        });
        if (res.ok) setStatus((await res.json()) as GoogleClientStatus);
      } catch {
        /* the tick stays local until the next load */
      }
    },
    [status],
  );

  const readFile = useCallback(async (f: File | undefined) => {
    if (!f) return;
    setFile({ name: f.name, text: await f.text() });
    setMessage(null);
  }, []);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy("save");
    setMessage(null);
    try {
      const payload = file
        ? { client_json: file.text }
        : { client_id: clientId.trim(), client_secret: clientSecret.trim() };
      const res = await fetch("/api/google-client", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, replace: replacing }),
      });
      if (!res.ok) {
        setMessage({ tone: "bad", key: await errorKey(res) });
        return;
      }
      const data = (await res.json()) as GoogleClientSaveResult;
      setStatus(data.client);
      setMessage(checkMessage(data.check));
      if (data.saved) {
        setReplacing(false);
        setFile(null);
        setClientId("");
        setClientSecret("");
      }
    } catch {
      setMessage({ tone: "bad", key: "err_generic" });
    } finally {
      setBusy(null);
    }
  }, [busy, file, clientId, clientSecret, replacing]);

  const test = useCallback(async () => {
    if (busy) return;
    setBusy("test");
    setMessage(null);
    try {
      const res = await fetch("/api/google-client/test", { method: "POST" });
      if (!res.ok) {
        setMessage({ tone: "bad", key: await errorKey(res) });
        return;
      }
      const data = (await res.json()) as {
        check: GoogleClientCheck;
        client: GoogleClientStatus;
      };
      setStatus(data.client);
      setMessage(checkMessage(data.check));
    } catch {
      setMessage({ tone: "bad", key: "err_generic" });
    } finally {
      setBusy(null);
    }
  }, [busy]);

  if (loadFailed) {
    return (
      <section data-component="GoogleClientSetup">
        <p className="text-xs text-red-400">{t("loadError")}</p>
      </section>
    );
  }
  if (!status) {
    return (
      <section data-component="GoogleClientSetup" aria-busy="true">
        <Spinner />
      </section>
    );
  }

  const done = status.configured && !replacing;
  const ticked = TICK_STEPS.filter((n) => status.steps[n]).length;
  const doneCount = status.configured ? 6 : ticked;
  const canSave = !busy && (file !== null || (clientId.trim() && clientSecret.trim()));

  const notice = message && (
    <p
      role="status"
      className={`mt-2 rounded-lg border px-2.5 py-2 text-[13px] ${message.tone === "ok" ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200" : "border-red-400/40 bg-red-400/10 text-red-300"}`}
    >
      {t(message.key)}
    </p>
  );

  const stepB = (
    <div
      className={`mt-3 flex flex-col gap-1 rounded-lg border border-[var(--color-surface-2)] p-2 ${status.configured ? "" : "opacity-60"}`}
    >
      <p className="text-sm font-semibold">{t("stepB")}</p>
      {status.configured ? (
        <p className="text-xs text-[var(--color-muted)]">
          {t("stepBOpen")}{" "}
          <a href="#connected-accounts" className="text-[var(--color-accent)]">
            {t("stepBLink")}
          </a>
        </p>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">{t("stepBLocked")}</p>
      )}
    </div>
  );

  if (done) {
    const kind =
      status.client_type === "installed"
        ? "doneDesktop"
        : status.client_type === "web"
          ? "doneWeb"
          : "doneOther";
    const last = status.last_check?.result;
    return (
      <section data-component="GoogleClientSetup" data-state="done">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <div className="mt-2 rounded-xl border border-emerald-500/35 bg-emerald-500/5 p-3">
          <p className="text-sm font-semibold text-emerald-200">✓ {t("doneTitle")}</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {t(kind, { id: status.client_id_hint ?? "" })}
            {status.source === "env" ? ` ${t("doneEnv")}` : ""}
          </p>
          {last && !message && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {last === "ok" ? t("lastCheckOk") : t("lastCheckBad")}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <ActionButton busyLabel={t("checking")}
              onAction={test}
              disabled={busy !== null}
              aria-busy={busy === "test"}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm disabled:opacity-50"
            >
              {busy === "test" && <Spinner />}
              {busy === "test" ? t("checking") : t("test")}
            </ActionButton>
            <button
              type="button"
              onClick={() => {
                setReplacing(true);
                setMessage(null);
              }}
              disabled={busy !== null}
              className="min-h-11 rounded-lg px-2 text-sm text-[var(--color-accent)] disabled:opacity-50"
            >
              {t("replace")}
            </button>
          </div>
          {notice}
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">{t("note")}</p>
        {stepB}
      </section>
    );
  }

  return (
    <section data-component="GoogleClientSetup" data-state="guide">
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{t("intro")}</p>
      <div className="mt-3 flex flex-col gap-1">
        <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
          <i
            className="block h-full bg-emerald-500"
            style={{ width: `${(doneCount / 6) * 100}%` }}
          />
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          {t("progress", { done: doneCount })}
        </p>
      </div>
      <p className="mt-2 text-xs text-[var(--color-muted)]">{t("tick")}</p>

      <ol className="mt-3 flex flex-col gap-3">
        <Step n={1} title={t("step1")} done={status.steps["1"]} onToggle={() => toggle("1")} t={t}>
          <p className="text-xs text-[var(--color-muted)]">{t("step1Body")}</p>
          <ConsoleLink href={CONSOLE.project} t={t} />
        </Step>
        <Step n={2} title={t("step2")} done={status.steps["2"]} onToggle={() => toggle("2")} t={t}>
          <p className="text-xs text-[var(--color-muted)]">{t("step2Body")}</p>
          <ConsoleLink href={CONSOLE.apis} t={t} />
        </Step>
        <Step n={3} title={t("step3")} done={status.steps["3"]} onToggle={() => toggle("3")} t={t}>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t("step3Body")}</p>
          <div className="mt-2 flex flex-col gap-2">
            <CopyBox value="Aquarium" label={t("appName")} t={t} />
            <p className="text-xs text-[var(--color-muted)]">
              {t("supportEmail")} · {t("developerEmail")}: {t("yourEmail")}
            </p>
          </div>
          <p className="mt-2 text-xs">{t("audience")}</p>
          <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-[var(--color-warn-text)]">
            {t("unverified")}
          </p>
          <ConsoleLink href={CONSOLE.branding} t={t} />
        </Step>
        <Step n={4} title={t("step4")} done={status.steps["4"]} onToggle={() => toggle("4")} t={t}>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t("step4Body")}</p>
          <div className="mt-2">
            <CopyBox value={status.scopes.join("\n")} multiline t={t} />
          </div>
          <ConsoleLink href={CONSOLE.scopes} t={t} />
        </Step>
        <Step n={5} title={t("step5")} done={status.steps["5"]} onToggle={() => toggle("5")} t={t}>
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t("step5Body")}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">{t("redirect")}</p>
          <div className="mt-1">
            <CopyBox value={status.redirect_uri} t={t} />
          </div>
          <ConsoleLink href={CONSOLE.client} t={t} />
        </Step>
        <Step n={6} title={t("step6")} done={status.configured} t={t}>
          {replacing && (
            <p className="mt-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-[var(--color-warn-text)]">
              {t("replaceIntro")}
              {status.source === "env" ? ` ${t("replaceEnv")}` : ""}
            </p>
          )}
          <p className="mt-1 text-xs text-[var(--color-muted)]">{t("step6Body")}</p>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void readFile(e.dataTransfer.files[0]);
            }}
            disabled={busy !== null}
            className={`mt-2 w-full rounded-[10px] border-2 border-dashed p-4 text-center text-[13px] ${dragging ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"} ${file ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
          >
            {file ? t("fileChosen", { name: file.name }) : `⬆ ${t("drop")}`}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="google-client-file"
            onChange={(e) => void readFile(e.target.files?.[0])}
          />
          <p className="mt-2 text-center text-xs text-[var(--color-muted)]">{t("or")}</p>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
              {t("clientId")}
              <input
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setFile(null);
                }}
                disabled={busy !== null}
                autoComplete="off"
                spellCheck={false}
                placeholder="1234567890-abc….apps.googleusercontent.com"
                className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-mono text-sm text-[var(--color-fg)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
              {t("clientSecret")}
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => {
                  setClientSecret(e.target.value);
                  setFile(null);
                }}
                disabled={busy !== null}
                autoComplete="off"
                spellCheck={false}
                placeholder="GOCSPX-…"
                className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-mono text-sm text-[var(--color-fg)]"
              />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ActionButton busyLabel={t("checking")}
              onAction={save}
              disabled={!canSave}
              aria-busy={busy === "save"}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {busy === "save" && <Spinner />}
              {busy === "save" ? t("checking") : t("saveAndTest")}
            </ActionButton>
            {replacing && (
              <button
                type="button"
                onClick={() => {
                  setReplacing(false);
                  setMessage(null);
                }}
                disabled={busy !== null}
                className="min-h-11 rounded-lg px-2 text-sm text-[var(--color-accent)] disabled:opacity-50"
              >
                {t("cancel")}
              </button>
            )}
          </div>
          {notice}
          <p className="mt-2 text-xs text-[var(--color-muted)]">{t("note")}</p>
        </Step>
      </ol>
      {stepB}
    </section>
  );
}
