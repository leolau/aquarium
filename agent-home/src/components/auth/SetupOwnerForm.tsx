"use client";

import { useEffect, useMemo, useState } from "react";

import { AuthCard, AuthIllustration } from "@/components/auth/AuthLayout";

import { TwoFactorSetup } from "@/components/account/TwoFactorSetup";
import { AquariumLoader } from "@/components/brand/AquariumLoader";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { CopyButton } from "@/components/skills/CopyButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { CheckIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage, sendJson } from "@/components/users/api";
import { useT, type Translator } from "@/i18n";
import type { SetupDomainResult, SetupModelResult } from "@/lib/api/client";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "@/components/ui/ActionButton";

/** Mirrors the server-side minimum; the server is still the authority. */
const MIN_PASSWORD_LENGTH = 12;

/** Where "Finish setup" lands: Settings → Get ready. */
export const GET_READY_PATH = "/settings/get-ready";

export const SETUP_LINK_INVALID =
  "This setup link is not valid. It may have expired (links last 24 hours) or " +
  "been used already. Ask whoever installed Aquarium to run \"hermes setup-link\" " +
  "on the server for a new one.";

/** Provider id (config.yaml `model.provider`) → label key, in the mockup's order. */
export const SETUP_PROVIDERS: { id: string; label: string; keyUrl: string }[] = [
  { id: "openrouter", label: "p_or", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "anthropic", label: "p_an", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai-api", label: "p_oa", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "deepseek", label: "p_ds", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "gemini", label: "p_gg", keyUrl: "https://aistudio.google.com/app/apikey" },
];

const COMMON_TIMEZONES = ["Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Europe/London", "America/New_York"];

/** The one-time token from a `#token=…` fragment, or "" when there is none. */
export function tokenFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return (params.get("token") ?? "").trim();
}

/**
 * A fragment change on /setup reloads only when it carries a new setup link;
 * in-page anchors (the step rail) must never wipe the half-filled form.
 */
export function hashCarriesSetupLink(hash: string): boolean {
  return tokenFromHash(hash) !== "";
}

type FormProblem = "errorEmail" | "errorShort" | "errorMismatch";

/** Local checks before posting; ``null`` when the form looks fine. */
export function setupFormProblem(email: string, password: string, confirm: string): FormProblem | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return "errorEmail";
  if (password.length < MIN_PASSWORD_LENGTH) return "errorShort";
  if (password !== confirm) return "errorMismatch";
  return null;
}

const PROBLEM_EN: Record<FormProblem, string> = {
  errorEmail: "Enter the owner's email address.",
  errorShort: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  errorMismatch: "The two passwords don't match.",
};

/** Wording of {@link setupFormProblem}; ``t`` is the "setup" translator (English without it). */
export function setupFormError(
  email: string,
  password: string,
  confirm: string,
  t?: Translator,
): string | null {
  const problem = setupFormProblem(email, password, confirm);
  if (!problem) return null;
  return t ? t(problem, { min: MIN_PASSWORD_LENGTH }) : PROBLEM_EN[problem];
}

/** The password login the owner just created belongs to (GoTrue first). */
export function ownerLoginProvider(providers: { name: string; supports_password: boolean }[]): string {
  const usable = providers.filter((p) => p.supports_password).map((p) => p.name);
  return usable.includes("supabase") ? "supabase" : (usable[0] ?? "");
}

/**
 * Browser-only strength hint, 0–3 (Too short / Weak / OK / Strong). Under the
 * 12-character minimum is always 0; length and mixing letters with digits,
 * spaces or symbols each add a step. The server's policy is still the authority.
 */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length < MIN_PASSWORD_LENGTH) return 0;
  let score = 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/i.test(password) && /[\d\s\W_]/.test(password)) score += 1;
  return Math.min(score, 3) as 0 | 1 | 2 | 3;
}

const STRENGTH_COLOURS = ["var(--color-danger)", "var(--color-warn)", "var(--color-warn-text)", "var(--color-success)"];

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function allTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return COMMON_TIMEZONES;
  }
}

type Phase = "checking" | "invalid" | "form" | "twoFactor" | "done";
type ModelState = { kind: "idle" } | { kind: "ok"; seconds: string; model: string } | { kind: "bad"; key: string | null; detail?: string };
type DomainState = { kind: "idle" } | { kind: "result"; result: SetupDomainResult } | { kind: "error"; message: string };

const card = "rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:p-5";
const field = "min-h-11 w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] read-only:opacity-70 focus:border-[var(--color-accent)] focus:outline-none";
const label = "flex flex-col gap-1.5 text-sm font-medium";
const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-60";
const okBox = "rounded-[var(--radius-lg)] border border-[var(--color-success)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-success)]";
const badBox = "rounded-[var(--radius-lg)] border border-[var(--color-danger)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-danger)]";
const warnBox = "rounded-[var(--radius-lg)] border border-[var(--color-warn)] bg-[var(--color-attention-bg)] px-3 py-2 text-sm text-[var(--color-warn-text)]";

/**
 * First-run setup from the link `hermes setup-link` prints (P2 screen 1):
 * owner login, AI model key with a live test, timezone + language, an optional
 * read-only domain check; "Finish setup" creates the owner, signs them in,
 * offers two-factor login on the same page and then opens Get ready.
 *
 * The token is read from the URL fragment in the browser, then removed from the
 * address bar (so it is not left in history or on screen) and only ever posted
 * in a JSON body. It is never rendered into the page.
 */
export function SetupOwnerForm({
  providers = [],
}: {
  providers?: { name: string; supports_password: boolean }[];
}) {
  const t = useT("setup");
  const ta = useT("account");
  const [phase, setPhase] = useState<Phase>("checking");
  const [steps, setSteps] = useState(true);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [provider, setProvider] = useState(SETUP_PROVIDERS[0].id);
  const [apiKey, setApiKey] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [model, setModel] = useState<ModelState>({ kind: "idle" });
  const [timezone, setTimezone] = useState("UTC");
  const [host, setHost] = useState("");
  const [domainBusy, setDomainBusy] = useState(false);
  const [domain, setDomain] = useState<DomainState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [current, setCurrent] = useState("s1");
  const [invalidStep, setInvalidStep] = useState<string | null>(null);

  useEffect(() => {
    const found = tokenFromHash(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    const asked = found
      ? sendJson<{ ok: boolean; steps?: boolean }>("/api/auth/setup/check", "POST", { token: found })
      : Promise.reject(new Error("no setup token in the link"));
    asked
      .then((res) => {
        setTimezone(browserTimezone());
        setToken(found);
        setSteps(res.steps !== false);
        setPhase("form");
      })
      .catch(() => setPhase("invalid"));
    // A link pasted into a tab already on /setup only changes the fragment, which
    // does not reload the page; reload so the new token is read.
    const onHashChange = () => {
      if (hashCarriesSetupLink(window.location.hash)) window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const timezones = useMemo(() => {
    const rest = allTimezones().filter((z) => !COMMON_TIMEZONES.includes(z));
    return { common: COMMON_TIMEZONES, rest };
  }, []);

  const strength = passwordStrength(password);
  const ownerDone = setupFormProblem(email, password, confirm) === null;
  const providerInfo = SETUP_PROVIDERS.find((p) => p.id === provider) ?? SETUP_PROVIDERS[0];

  async function testModel() {
    if (modelBusy) return;
    if (!apiKey.trim()) {
      setModel({ kind: "bad", key: "s3_need_key" });
      return;
    }
    setModelBusy(true);
    setModel({ kind: "idle" });
    try {
      const res = await sendJson<SetupModelResult>("/api/auth/setup/model", "POST", {
        token,
        provider,
        api_key: apiKey.trim(),
      });
      if (res.ok) {
        setModel({ kind: "ok", seconds: ((res.latency_ms ?? 0) / 1000).toFixed(1), model: res.model ?? "" });
        setApiKey("");
      } else {
        setModel({ kind: "bad", key: res.error === "key_rejected" ? "s3_key_bad" : "s3_test_bad", detail: res.detail });
      }
    } catch (err) {
      setModel({ kind: "bad", key: null, detail: errorMessage(err, t("err_network")) });
    } finally {
      setModelBusy(false);
    }
  }

  async function checkDomain() {
    if (domainBusy) return;
    if (!host.trim()) {
      setDomain({ kind: "error", message: t("s5_need") });
      return;
    }
    setDomainBusy(true);
    setDomain({ kind: "idle" });
    try {
      const result = await sendJson<SetupDomainResult>("/api/auth/setup/domain", "POST", { token, host });
      setDomain({ kind: "result", result });
    } catch (err) {
      setDomain({ kind: "error", message: errorMessage(err, t("err_network")) });
    } finally {
      setDomainBusy(false);
    }
  }

  /** Steps are buttons: scroll in place and move focus, never touch the fragment. */
  function goToStep(id: string) {
    setCurrent(id);
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (phase !== "form" || typeof IntersectionObserver === "undefined") return;
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-setup-step]"));
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [phase, steps]);

  function openGetReady() {
    setPassword("");
    setConfirm("");
    setLeaving(true);
    window.location.assign(GET_READY_PATH);
  }

  async function finish(evt: React.FormEvent) {
    evt.preventDefault();
    if (finishing) return;
    setError(null);
    setInvalidStep(null);
    const problem = setupFormError(email, password, confirm, t);
    if (problem) {
      setError(problem);
      setInvalidStep("s1");
      goToStep("s1");
      return;
    }
    setFinishing(true);
    try {
      // Region first: the link is used up once the owner exists.
      if (steps) {
        await sendJson("/api/auth/setup/region", "POST", { token, timezone });
      }
      await sendJson("/api/auth/setup/owner", "POST", { token, email: email.trim(), password });
    } catch (err) {
      setError(errorMessage(err, t.has("invalidFull") ? t("invalidFull") : SETUP_LINK_INVALID));
      setFinishing(false);
      return;
    }
    // Sign straight in (this also saves the language chosen on this page for
    // the owner), so the optional two-factor step can run here.
    const loginProvider = ownerLoginProvider(providers);
    const login = loginProvider
      ? await fetch("/api/session/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: loginProvider, username: email.trim(), password }),
        }).catch(() => null)
      : null;
    setFinishing(false);
    setPhase(login?.ok ? "twoFactor" : "done");
  }
  // Enter pressed twice submits twice before `busy` renders; the lock stops it.
  const { run: finishOnce } = useAction(finish);

  if (phase === "checking") {
    return (
      <AuthCard component="SetupChecking" className="mx-auto w-full max-w-[420px] items-center gap-3 text-center">
        <div aria-busy="true" className="flex flex-col items-center gap-3">
          <AquariumLoader size={56} label={t("checking")} />
          <p className="text-sm text-[var(--color-muted)]">{t("checking")}</p>
        </div>
      </AuthCard>
    );
  }
  if (phase === "invalid") {
    const [before, after = ""] = t("invalidHelp").split("{command}");
    return (
      <AuthCard component="SetupInvalid" className="mx-auto w-full max-w-[420px] gap-4 text-sm">
        <div role="alert" className="flex flex-col gap-3">
          <AuthIllustration name="lostFish" className="self-start" />
          <h1 className="text-[26px] font-semibold tracking-tight">{t("invalidTitle")}</h1>
          <p>{t("invalid")}</p>
          <p className="text-[var(--color-muted)]">
            {before}
            <code className="font-mono">hermes setup-link</code>
            {after}
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">hermes setup-link</code>
          <CopyButton text="hermes setup-link" label={t("copyCommand")} className={btn} />
        </div>
      </AuthCard>
    );
  }
  if (phase === "done") {
    return (
      <AuthCard component="SetupDone" className="mx-auto w-full max-w-[420px] gap-4 text-sm">
        <AuthIllustration name="welcome" className="self-start" />
        <InlineAlert tone="success">{t("done")}</InlineAlert>
        <a href="/login" className={`${primary} w-full`}>
          {t("signIn")}
        </a>
      </AuthCard>
    );
  }
  if (phase === "twoFactor") {
    return (
      <section data-component="SetupTwoFactor" className={`${card} mx-auto flex w-full max-w-2xl flex-col gap-3 text-sm lg:p-8`}>
        <h2 className="text-base font-semibold">{t("s2_t")}</h2>
        <p className="text-xs text-[var(--color-muted)]">{ta("s2Desc")}</p>
        {leaving ? (
          <p aria-busy="true" className="flex items-center gap-2 text-[var(--color-muted)]">
            <Spinner /> {t("opening")}
          </p>
        ) : (
          <>
            <TwoFactorSetup
              t={ta}
              password={password}
              onDone={openGetReady}
              onCancel={openGetReady}
              cancelLabel={ta("skip")}
            />
            <p className="text-xs text-[var(--color-muted)]">{ta("skipLater")}</p>
          </>
        )}
      </section>
    );
  }

  const stepClass = (id: string) =>
    `${card} flex scroll-mt-6 flex-col gap-3 focus:outline-none ${
      id === invalidStep
        ? "border-[var(--color-danger)]"
        : id === current
          ? "lg:border-[var(--color-accent)]"
          : ""
    }`;

  const rail: { id: string; key: string; done: boolean }[] = [
    { id: "s1", key: "r1", done: ownerDone },
    { id: "s2", key: "r2", done: false },
    ...(steps
      ? [
          { id: "s3", key: "r3", done: model.kind === "ok" },
          { id: "s4", key: "r4", done: false },
          { id: "s5", key: "r5", done: domain.kind === "result" && domain.result.points_here },
        ]
      : []),
  ];
  const domainResult = domain.kind === "result" ? domain.result : null;
  const address = domainResult?.server_addresses[0];

  return (
    <form
      data-component="SetupOwnerForm"
      onSubmit={(e) => void finishOnce(e)}
      aria-busy={finishing}
      className="grid min-w-0 gap-4 lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-7"
    >
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <AuthIllustration name="welcome" className="hidden lg:block lg:h-[100px]" />
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          <span className="lg:hidden">{t("stepOf", { n: Math.max(1, rail.findIndex((r) => r.id === current) + 1), total: rail.length })}</span>
          <span className="hidden lg:inline">{t("steps")}</span>
        </p>
        <nav aria-label={t("steps")} className="flex flex-wrap gap-2 lg:flex-col">
          {rail.map((r, i) => {
            const isCurrent = r.id === current;
            const isInvalid = r.id === invalidStep;
            return (
              <button
                key={r.id}
                type="button"
                data-action="setup-step"
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => goToStep(r.id)}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-full)] border px-3 text-left text-xs lg:rounded-[var(--radius-lg)] lg:text-sm ${
                  isInvalid
                    ? "border-[var(--color-danger)] text-[var(--color-text)]"
                    : isCurrent
                      ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    r.done
                      ? "bg-[var(--color-success)] text-[var(--color-bg)]"
                      : isCurrent
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                  }`}
                >
                  {r.done ? <CheckIcon size={14} /> : i + 1}
                </span>
                {t(r.key)}
                {r.done ? <span className="sr-only">({t("stepDone")})</span> : null}
              </button>
            );
          })}
        </nav>
        <p className="hidden text-xs text-[var(--color-muted)] lg:block">{t("stepsHelp")}</p>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("title")}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {steps ? t("setup_intro") : t("reset_intro")}
          </p>
        </div>

        <section id="s1" data-setup-step tabIndex={-1} className={stepClass("s1")}>
          <StepHead title={t("s1_t")} done={ownerDone} doneLabel={t("stepDone")} />
          <p className="text-xs text-[var(--color-muted)]">{t("s1_d")}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={`${label} md:col-span-2 md:max-w-[calc(50%-0.375rem)]`}>
              {t("email")}
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
            </label>
            <label className={label}>
              <span className="flex min-h-11 items-center justify-between">
                {t("password")}
                <button type="button" onClick={() => setShowPw((v) => !v)} className="px-1 text-xs text-[var(--color-accent)]">
                  {showPw ? t("hide") : t("show")}
                </button>
              </span>
              <input
                type={showPw ? "text" : "password"}
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
              />
              <span data-component="PasswordStrength" className="flex items-center gap-2" aria-live="polite">
                <span className="flex flex-1 gap-1" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1 flex-1 rounded-full"
                      style={{ background: password && i < Math.max(strength, 1) ? STRENGTH_COLOURS[strength] : "var(--color-border)" }}
                    />
                  ))}
                </span>
                <span className="text-xs" style={{ color: password ? STRENGTH_COLOURS[strength] : "var(--color-muted)" }}>
                  {t(`st${strength}`)} · {password.length} {t("pw_len")}
                </span>
              </span>
              <span className="text-xs text-[var(--color-muted)]">{t("pw_hint")}</span>
            </label>
            <label className={label}>
              <span className="flex min-h-11 items-center">{t("confirm")}</span>
              <input
                type={showPw ? "text" : "password"}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={field}
              />
              {confirm ? (
                <span className={`text-xs ${confirm === password ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}`}>
                  {confirm === password ? t("pw_match") : t("pw_nomatch")}
                </span>
              ) : null}
            </label>
          </div>
        </section>

        <section id="s2" data-setup-step tabIndex={-1} className={stepClass("s2")}>
          <StepHead title={t("s2_t")} />
          <p className="text-xs text-[var(--color-muted)]">{t("s2_d")}</p>
          <p data-component="TwoFactorLater" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
            {t("s2_after")}
          </p>
        </section>

        {steps ? (
          <>
            <section id="s3" data-setup-step tabIndex={-1} className={stepClass("s3")} aria-busy={modelBusy}>
              <StepHead title={t("s3_t")} done={model.kind === "ok"} doneLabel={t("stepDone")} />
              <p className="text-xs text-[var(--color-muted)]">{t("s3_d")}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <label className={label}>
                  {t("provider")}
                  <select
                    value={provider}
                    disabled={modelBusy}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setModel({ kind: "idle" });
                    }}
                    className={field}
                  >
                    {SETUP_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {t(p.label)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={label}>
                  {t("apikey")}
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    disabled={modelBusy}
                    placeholder={model.kind === "ok" ? "••••••••" : ""}
                    onChange={(e) => setApiKey(e.target.value)}
                    className={`${field} font-mono`}
                  />
                  <a className="text-xs text-[var(--color-accent)]" href={providerInfo.keyUrl} target="_blank" rel="noreferrer">
                    {t("findkey")}
                  </a>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ActionButton busyLabel={t("testing")} onAction={testModel} disabled={modelBusy || finishing} className={primary}>
                  {modelBusy ? (
                    <>
                      <Spinner /> {t("testing")}
                    </>
                  ) : (
                    t("test")
                  )}
                </ActionButton>
                {modelBusy ? <span className="text-xs text-[var(--color-muted)]">{t("s3_testing")}</span> : null}
              </div>
              {model.kind === "ok" ? (
                <p role="status" className={okBox}>
                  {t("s3_ok", { seconds: model.seconds })} {model.model ? t("s3_saved_model", { model: model.model }) : null}
                </p>
              ) : null}
              {model.kind === "bad" ? (
                <p role="alert" className={badBox}>
                  {model.key ? t(model.key) : model.detail}
                </p>
              ) : null}
              <p className="text-xs text-[var(--color-muted)]">{t("s3_model")}</p>
              <p className="text-xs text-[var(--color-muted)]">{t("s3_skip")}</p>
            </section>

            <section id="s4" data-setup-step tabIndex={-1} className={stepClass("s4")}>
              <StepHead title={t("s4_t")} />
              <div className="grid gap-3 md:grid-cols-2">
                <label className={label}>
                  {t("tz")}
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={field}>
                    {[timezone, ...timezones.common.filter((z) => z !== timezone)].map((z) => (
                      <option key={`c-${z}`} value={z}>
                        {z.replace(/_/g, " ")}
                      </option>
                    ))}
                    <optgroup label={t("tz_other")}>
                      {timezones.rest
                        .filter((z) => z !== timezone)
                        .map((z) => (
                          <option key={z} value={z}>
                            {z.replace(/_/g, " ")}
                          </option>
                        ))}
                    </optgroup>
                  </select>
                  <span className="text-xs text-[var(--color-muted)]">{t("tz_note")}</span>
                </label>
                <div className={label}>
                  <LanguageSwitch showNote />
                </div>
              </div>
            </section>

            <section id="s5" data-setup-step tabIndex={-1} className={stepClass("s5")} aria-busy={domainBusy}>
              <StepHead title={t("s5_t")} done={domain.kind === "result" && domain.result.points_here} doneLabel={t("stepDone")} />
              <p className="text-xs text-[var(--color-muted)]">{t("s5_d")}</p>
              <label className={label}>
                {t("addr")}
                <span className="flex gap-2">
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("addr_ph")}
                    value={host}
                    disabled={domainBusy}
                    onChange={(e) => setHost(e.target.value)}
                    className={`${field} min-w-0 flex-1`}
                  />
                  <ActionButton busyLabel={t("checkingDomain")} onAction={checkDomain} disabled={domainBusy || finishing} className={btn}>
                    {domainBusy ? (
                      <>
                        <Spinner /> {t("checkingDomain")}
                      </>
                    ) : (
                      t("check")
                    )}
                  </ActionButton>
                </span>
              </label>
              {domainResult ? (
                domainResult.points_here ? (
                  <div role="status" className={`${domainResult.https_ready ? okBox : warnBox} flex flex-col gap-1`}>
                    <span>{t("s5_r1")}</span>
                    <span>{domainResult.https_ready ? t("s5_r2") : t("s5_no_https")}</span>
                    {domainResult.https_ready ? (
                      <span className="text-xs text-[var(--color-text)]">{t("s5_next", { host: domainResult.host })}</span>
                    ) : null}
                  </div>
                ) : (
                  <p role="alert" className={badBox}>
                    {domainResult.resolves ? t("s5_bad_name") : t("s5_no_name")}
                  </p>
                )
              ) : null}
              {domain.kind === "error" ? (
                <p role="alert" className={badBox}>
                  {domain.message}
                </p>
              ) : null}
              <p className="text-xs text-[var(--color-muted)]">{address ? t("s5_how", { address }) : t("s5_how_noaddr")}</p>
            </section>
          </>
        ) : null}

        <div className="flex flex-col gap-2">
          {error ? (
            <p role="alert" className={badBox}>
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={finishing || modelBusy || domainBusy} className={`${primary} w-full py-3`}>
            {finishing ? (
              <>
                <Spinner /> {t("saving")}
              </>
            ) : (
              t("finish")
            )}
          </button>
          <p className="text-center text-xs text-[var(--color-muted)]">{t("finish_note")}</p>
        </div>
      </div>
    </form>
  );
}

/** A step's numbered title with its status pill (Figma `section-card` 16:207). */
function StepHead({ title, done = false, doneLabel }: { title: string; done?: boolean; doneLabel?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
      {done ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-success)]">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          {doneLabel}
        </span>
      ) : null}
    </div>
  );
}
