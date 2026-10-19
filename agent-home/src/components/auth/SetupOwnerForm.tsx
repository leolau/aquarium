"use client";

import { useEffect, useMemo, useState } from "react";

import { TwoFactorSetup } from "@/components/account/TwoFactorSetup";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage, sendJson } from "@/components/users/api";
import { useT, type Translator } from "@/i18n";
import type { SetupDomainResult, SetupModelResult } from "@/lib/api/client";

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

const STRENGTH_COLOURS = ["#ef4444", "#f59e0b", "#eab308", "#10b981"];

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

const card = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const field = "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)]";
const label = "flex flex-col gap-1.5 text-sm";
const btn = "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const primary = "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-60";
const okBox = "rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300";
const badBox = "rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300";
const warnBox = "rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-[var(--color-warn-text)]";

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
    const onHashChange = () => window.location.reload();
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
    const problem = setupFormError(email, password, confirm, t);
    if (problem) {
      setError(problem);
      document.getElementById("s1")?.scrollIntoView({ behavior: "smooth" });
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

  if (phase === "checking") {
    return (
      <p data-component="SetupChecking" aria-busy="true" className="text-sm text-[var(--color-muted)]">
        {t("checking")}
      </p>
    );
  }
  if (phase === "invalid") {
    const [before, after = ""] = t("invalidHelp").split("{command}");
    return (
      <div className="flex flex-col gap-4">
        <LanguageSwitch />
        <div data-component="SetupInvalid" role="alert" className={`${card} text-sm`}>
          <p>{t("invalid")}</p>
          <p className="mt-2 text-[var(--color-muted)]">
            {before}
            <code className="font-mono">hermes setup-link</code>
            {after}
          </p>
        </div>
      </div>
    );
  }
  if (phase === "done") {
    return (
      <div data-component="SetupDone" className={`${card} text-sm`}>
        <p>{t("done")}</p>
        <a href="/login" className={`${primary} mt-3`}>
          {t("signIn")}
        </a>
      </div>
    );
  }
  if (phase === "twoFactor") {
    return (
      <section data-component="SetupTwoFactor" className={`${card} mx-auto flex w-full max-w-2xl flex-col gap-3 text-sm`}>
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
      onSubmit={finish}
      aria-busy={finishing}
      className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6"
    >
      <nav aria-label={t("steps")} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:sticky lg:top-20 lg:flex-col lg:self-start lg:overflow-visible">
        {rail.map((r, i) => (
          <a
            key={r.id}
            href={`#${r.id}`}
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs lg:rounded-lg lg:text-sm ${
              r.done ? "border-emerald-500/40 text-emerald-300" : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                r.done ? "bg-emerald-500 text-black" : "bg-[var(--color-surface-2)] text-[var(--color-text)]"
              }`}
            >
              {r.done ? "✓" : i + 1}
            </span>
            {t(r.key)}
          </a>
        ))}
      </nav>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-[var(--color-muted)]">
            {steps ? t("setup_intro") : t("reset_intro")}
          </p>
        </div>

        <section id="s1" className={`${card} flex scroll-mt-20 flex-col gap-3`}>
          <h3 className="font-semibold">{t("s1_t")}</h3>
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
                <span className={`text-xs ${confirm === password ? "text-emerald-300" : "text-red-300"}`}>
                  {confirm === password ? t("pw_match") : t("pw_nomatch")}
                </span>
              ) : null}
            </label>
          </div>
        </section>

        <section id="s2" className={`${card} flex scroll-mt-20 flex-col gap-3`}>
          <h3 className="font-semibold">{t("s2_t")}</h3>
          <p className="text-xs text-[var(--color-muted)]">{t("s2_d")}</p>
          <p data-component="TwoFactorLater" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
            {t("s2_after")}
          </p>
        </section>

        {steps ? (
          <>
            <section id="s3" className={`${card} flex scroll-mt-20 flex-col gap-3`} aria-busy={modelBusy}>
              <h3 className="font-semibold">{t("s3_t")}</h3>
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
                <button type="button" onClick={testModel} disabled={modelBusy || finishing} className={primary}>
                  {modelBusy ? (
                    <>
                      <Spinner /> {t("testing")}
                    </>
                  ) : (
                    t("test")
                  )}
                </button>
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

            <section id="s4" className={`${card} flex scroll-mt-20 flex-col gap-3`}>
              <h3 className="font-semibold">{t("s4_t")}</h3>
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

            <section id="s5" className={`${card} flex scroll-mt-20 flex-col gap-3`} aria-busy={domainBusy}>
              <h3 className="font-semibold">{t("s5_t")}</h3>
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
                  <button type="button" onClick={checkDomain} disabled={domainBusy || finishing} className={btn}>
                    {domainBusy ? (
                      <>
                        <Spinner /> {t("checkingDomain")}
                      </>
                    ) : (
                      t("check")
                    )}
                  </button>
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
