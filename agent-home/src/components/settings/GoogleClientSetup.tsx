"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { InfoTip } from "@/components/ui/InfoTip";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { CheckIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Spinner";
import { useConfirm } from "@/components/ui/useConfirm";
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

function StepChip({ n, done, current }: { n: number | string; done: boolean; current: boolean }) {
  const tone = done
    ? "bg-[var(--color-success)] text-[var(--color-bg)]"
    : current
      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
      : "bg-[var(--color-surface-2)] text-[var(--color-muted)]";
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-5 min-w-8 shrink-0 items-center justify-center rounded-[var(--radius-full)] px-1.5 text-[11px] font-semibold ${tone}`}
    >
      {done ? <CheckIcon size={12} /> : n}
    </span>
  );
}

function Step({
  n,
  title,
  done,
  current,
  open,
  onReopen,
  onToggle,
  disabled,
  t,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  current: boolean;
  open: boolean;
  onReopen: () => void;
  onToggle?: () => unknown;
  disabled?: boolean;
  t: GoogleClientT;
  children: ReactNode;
}) {
  return (
    <li
      id={`google-step-${n}`}
      data-step={n}
      className={`scroll-mt-24 rounded-[var(--radius-lg)] border bg-[var(--color-surface)] p-4 md:p-5 ${current ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
    >
      <div className="flex items-start gap-3">
        <StepChip n={n} done={done} current={current} />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">
            {n}. {title}
          </h3>
          {open ? (
            children
          ) : (
            <button
              type="button"
              onClick={onReopen}
              className="mt-1 min-h-9 text-xs text-[var(--color-accent)]"
            >
              {t("reopen")}
            </button>
          )}
        </div>
        {onToggle ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={done}
            aria-label={t("markDone", { n })}
            onClick={onToggle}
            disabled={disabled}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border-2 ${done ? "border-[var(--color-success)] bg-[var(--color-success)] text-[var(--color-bg)]" : "border-[var(--color-border)]"}`}
          >
            {done ? <CheckIcon size={14} /> : null}
          </button>
        ) : null}
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
  const [reopened, setReopened] = useState<Set<number>>(new Set());
  const { ask, dialog } = useConfirm();
  const dirty = file !== null || clientId.trim() !== "" || clientSecret.trim() !== "";

  // Unsaved client values: closing the tab or following a link asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.hash) return;
      e.preventDefault();
      e.stopPropagation();
      void ask({
        title: t("leaveTitle"),
        body: t("leaveBody"),
        confirmLabel: t("leaveConfirm"),
        cancelLabel: t("stay"),
        tone: "danger",
      }).then((ok) => {
        if (ok) window.location.assign(url.href);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, ask, t]);

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
        <p className="text-xs text-[var(--color-danger)]">{t("loadError")}</p>
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
    <div className="mt-2">
      <InlineAlert tone={message.tone === "ok" ? "success" : "danger"}>{t(message.key)}</InlineAlert>
    </div>
  );

  const stepB = (
    <div
      data-component="GoogleStepB"
      className={`rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${status.configured ? "" : "opacity-70"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t("stepB")}</p>
        {status.configured ? null : (
          <span className="rounded-[var(--radius-full)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
            {t("stepBLocked")}
          </span>
        )}
      </div>
      {status.configured ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {t("stepBOpen")}{" "}
          <a href="#connected-accounts" className="text-[var(--color-accent)]">
            {t("stepBLink")}
          </a>
        </p>
      ) : null}
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
        <div className="mt-2 rounded-xl border border-[var(--color-success)]/35 bg-[var(--color-success)]/5 p-3">
          <p className="text-sm font-semibold text-[var(--color-success)]">✓ {t("doneTitle")}</p>
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
        <div className="mt-3">{stepB}</div>
      </section>
    );
  }

  const STEP_NUMS = [1, 2, 3, 4, 5, 6] as const;
  const isDone = (n: number) => (n === 6 ? status.configured && !replacing : status.steps[String(n) as TickStep]);
  const current = STEP_NUMS.find((n) => !isDone(n)) ?? 6;
  const isOpen = (n: number) => !isDone(n) || reopened.has(n);
  const jump = (n: number) => {
    setReopened((prev) => new Set(prev).add(n));
    window.requestAnimationFrame(() =>
      document.getElementById(`google-step-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const discard = () => {
    setFile(null);
    setClientId("");
    setClientSecret("");
    setMessage(null);
  };
  const stepProps = (n: number) => ({
    n,
    done: isDone(n),
    current: n === current,
    open: isOpen(n),
    onReopen: () => jump(n),
    t,
  });

  const saveBar = dirty ? (
    <div
      data-component="SaveBar"
      role="region"
      aria-label={t("unsaved")}
      className="sticky bottom-[calc(var(--coral-clearance)+var(--safe-bottom)+0.5rem)] z-20 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-surface)] p-3 shadow-lg lg:bottom-4"
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warn)]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-warn-text)]">{t("unsaved")}</p>
        <p className="text-xs text-[var(--color-muted)]">{t("unsavedBody")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={discard}
          disabled={busy !== null}
          className="min-h-11 rounded-[var(--radius-lg)] px-3 text-sm disabled:opacity-50"
        >
          {t("discard")}
        </button>
        <ActionButton
          busyLabel={t("checking")}
          onAction={save}
          disabled={!canSave}
          aria-busy={busy === "save"}
          className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {busy === "save" && <Spinner />}
          {busy === "save" ? t("checking") : t("saveAndTest")}
        </ActionButton>
      </div>
    </div>
  ) : null;

  return (
    <section
      data-component="GoogleClientSetup"
      data-state="guide"
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start"
    >
      {dialog}
      <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4">
        <nav
          aria-label={t("title")}
          className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("title")}</h2>
            <span className="rounded-[var(--radius-full)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-accent)]">
              {t("progress", { done: doneCount })}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
            <i className="block h-full bg-[var(--color-success)]" style={{ width: `${(doneCount / 6) * 100}%` }} />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">{t("stepsHint")}</p>
          <ol className="mt-2 flex flex-col">
            {STEP_NUMS.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  data-stepper={n}
                  aria-current={n === current ? "step" : undefined}
                  onClick={() => jump(n)}
                  className="flex min-h-11 w-full items-start gap-3 rounded-[var(--radius-md)] p-2 text-left hover:bg-[var(--color-surface-2)]"
                >
                  <StepChip n={n} done={isDone(n)} current={n === current} />
                  <span className="min-w-0 text-sm font-semibold">{t(`step${n}` as GoogleClientKey)}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {stepB}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-[var(--color-muted)]">{t("intro")}</p>
        <p className="text-xs text-[var(--color-muted)]">{t("tick")}</p>
        <ol className="flex flex-col gap-3">
          <Step {...stepProps(1)} title={t("step1")} onToggle={() => toggle("1")}>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step1Body")}</p>
            <ConsoleLink href={CONSOLE.project} t={t} />
          </Step>
          <Step {...stepProps(2)} title={t("step2")} onToggle={() => toggle("2")}>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step2Body")}</p>
            <ConsoleLink href={CONSOLE.apis} t={t} />
          </Step>
          <Step {...stepProps(3)} title={t("step3")} onToggle={() => toggle("3")}>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step3Body")}</p>
            <div className="mt-2 flex flex-col gap-2">
              <CopyBox value="Aquarium" label={t("appName")} t={t} />
              <p className="text-xs text-[var(--color-muted)]">
                {t("supportEmail")} · {t("developerEmail")}: {t("yourEmail")}
              </p>
            </div>
            <p className="mt-2 text-xs">{t("audience")}</p>
            <div className="mt-2">
              <InlineAlert tone="warn">{t("unverified")}</InlineAlert>
            </div>
            <ConsoleLink href={CONSOLE.branding} t={t} />
          </Step>
          <Step {...stepProps(4)} title={t("step4")} onToggle={() => toggle("4")}>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step4Body")}</p>
            <div className="mt-2">
              <CopyBox value={status.scopes.join("\n")} multiline t={t} />
            </div>
            <ConsoleLink href={CONSOLE.scopes} t={t} />
          </Step>
          <Step {...stepProps(5)} title={t("step5")} onToggle={() => toggle("5")}>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step5Body")}</p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">{t("redirect")}</p>
            <div className="mt-1">
              <CopyBox value={status.redirect_uri} t={t} />
            </div>
            <ConsoleLink href={CONSOLE.client} t={t} />
          </Step>
          <Step {...stepProps(6)} title={t("step6")}>
            {replacing && (
              <div className="mt-2">
                <InlineAlert tone="warn">
                  {t("replaceIntro")}
                  {status.source === "env" ? ` ${t("replaceEnv")}` : ""}
                </InlineAlert>
              </div>
            )}
            <p className="mt-1 text-sm text-[var(--color-muted)]">{t("step6Body")}</p>
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
              className={`mt-3 w-full break-words rounded-[var(--radius-lg)] border-2 border-dashed p-4 text-center text-[13px] ${dragging ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"} ${file ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
            >
              {file ? t("fileChosen", { name: file.name }) : t("drop")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              data-testid="google-client-file"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
            <p className="mt-2 text-xs text-[var(--color-muted)]">{t("or")}</p>
            <div className="mt-1 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium">
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
                  className="min-h-11 w-full min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-mono text-sm font-normal text-[var(--color-fg)]"
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-sm font-medium">
                  <label htmlFor="google-client-secret">{t("clientSecret")}</label>
                  <InfoTip label={t("secretTipLabel")}>{t("secretTip")}</InfoTip>
                </span>
                <input
                  id="google-client-secret"
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
                  className="min-h-11 w-full min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-mono text-sm text-[var(--color-fg)]"
                />
              </div>
            </div>
            {replacing && (
              <button
                type="button"
                onClick={() => {
                  setReplacing(false);
                  discard();
                }}
                disabled={busy !== null}
                className="mt-2 min-h-11 rounded-[var(--radius-lg)] px-2 text-sm text-[var(--color-accent)] disabled:opacity-50"
              >
                {t("cancel")}
              </button>
            )}
            <div className="mt-3">
              <InlineAlert tone="info">{t("ownerOnly")}</InlineAlert>
            </div>
          </Step>
        </ol>
        {notice}
        {saveBar}
      </div>
    </section>
  );
}
