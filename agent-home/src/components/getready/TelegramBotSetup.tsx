"use client";

/**
 * Get ready item 6 — the signed-in person's own Telegram bot.
 *
 * Step 1: create a bot with @BotFather, paste its token, "Save and test"
 * (Hermes checks it with Telegram getMe and keeps it in the person's private
 * credential store; the token never comes back to the browser).
 * Step 2: "Link my Telegram account" gets a one-time t.me link; the person
 * presses Start in Telegram and then "Check", which records their Telegram id.
 * From then on the gateway runs the bot for this person only.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  errorKey,
  pickLocale,
  translate,
  type TelegramBotKey,
} from "@/components/getready/telegramBotMessages";
import { Spinner } from "@/components/ui/Spinner";
import type { TelegramBotView } from "@/types";

type Busy = "save" | "test" | "linkStart" | "linkCheck" | "unlink" | "remove" | null;

const BTN =
  "inline-flex items-center justify-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

async function call(path: string, method: string, body?: unknown): Promise<TelegramBotView> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as TelegramBotView & { detail?: string };
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

const noopSubscribe = () => () => {};

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[11px] font-semibold">
        {n}
      </span>
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function TelegramBotSetup({ lang }: { lang?: string } = {}) {
  const pageLang = useSyncExternalStore(
    noopSubscribe,
    () => document.documentElement.lang,
    () => "",
  );
  const locale = pickLocale(lang ?? pageLang);
  const t = useCallback(
    (key: TelegramBotKey, vars?: Record<string, string>) => translate(locale, key, vars),
    [locale],
  );
  const [view, setView] = useState<TelegramBotView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const fetchView = useCallback(() => {
    call("/api/telegram-bot", "GET").then(setView, () => setLoadError(true));
  }, []);
  useEffect(fetchView, [fetchView]);
  const load = () => {
    setLoadError(false);
    fetchView();
  };

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<TelegramBotView>, ok?: (v: TelegramBotView) => string | null) {
    if (busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      const next = await fn();
      setView(next);
      const msg = ok?.(next);
      if (msg) setNotice({ kind: "ok", text: msg });
    } catch (err) {
      setNotice({ kind: "error", text: t(errorKey(err instanceof Error ? err.message : "")) });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", () => call("/api/telegram-bot", "PUT", { token: token.trim() }), () => {
      setToken("");
      setReplacing(false);
      setLinkUrl(null);
      return t("botOk");
    });
  const test = () =>
    run("test", () => call("/api/telegram-bot/test", "POST"), (v) =>
      v.last_test_ok ? t("botOk") : null,
    );
  const linkStart = () =>
    run("linkStart", () => call("/api/telegram-bot/link/start", "POST"), (v) => {
      setLinkUrl(v.link_url ?? null);
      return null;
    });
  const linkCheck = () =>
    run("linkCheck", () => call("/api/telegram-bot/link/check", "POST"), (v) => {
      if (v.linked) {
        setLinkUrl(null);
        return null;
      }
      return t("linkNotYet");
    });
  const unlink = () =>
    run("unlink", () => call("/api/telegram-bot/link", "DELETE"), () => {
      setLinkUrl(null);
      return null;
    });
  const remove = () =>
    run("remove", () => call("/api/telegram-bot", "DELETE"), () => {
      setLinkUrl(null);
      setReplacing(false);
      return null;
    });

  const label = (kind: Busy, idle: TelegramBotKey, working: TelegramBotKey) =>
    busy === kind ? (
      <>
        <Spinner /> {t(working)}
      </>
    ) : (
      t(idle)
    );

  const showTokenForm = !view?.configured || replacing;
  const testFailed = view?.configured && view.last_test_ok === false;

  return (
    <section data-component="TelegramBotSetup" data-section="telegram-bot" className="space-y-4" aria-busy={busy !== null}>
      <div>
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-xs text-[var(--color-muted)]">
          {view && !view.configured ? t("notStarted") : t("intro")}
        </p>
      </div>

      {view === null ? (
        loadError ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {t("loadFailed")}{" "}
            <button type="button" className="underline" onClick={load}>
              {t("retry")}
            </button>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <Spinner /> {t("loading")}
          </p>
        )
      ) : (
        <>
          <div className="space-y-2">
            <Step n={1} text={t("step1")} />
            {showTokenForm ? (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--color-muted)]">
                  {t("tokenLabel")}
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    disabled={busy !== null}
                    placeholder={t("tokenPlaceholder")}
                    onChange={(e) => setToken(e.target.value)}
                    className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-xs"
                  />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className={BTN_PRIMARY} disabled={busy !== null || token.trim() === ""}>
                    {label("save", "saveTest", "testing")}
                  </button>
                  {replacing ? (
                    <button type="button" className={BTN} disabled={busy !== null} onClick={() => setReplacing(false)}>
                      {t("cancel")}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className={`truncate text-sm font-medium ${testFailed ? "text-[var(--color-danger)]" : ""}`}>
                    {testFailed ? "✗" : "✓"} @{view.bot_username}
                  </p>
                  {testFailed ? (
                    <p className="text-xs text-[var(--color-danger)]">
                      {t("testFailed", { error: view.last_test_error ?? "" })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} disabled={busy !== null} onClick={() => void test()}>
                    {label("test", "test", "testing")}
                  </button>
                  <button type="button" className={BTN} disabled={busy !== null} onClick={() => setReplacing(true)}>
                    {t("replaceToken")}
                  </button>
                  <button type="button" className={`${BTN} text-[var(--color-danger)]`} disabled={busy !== null} onClick={() => void remove()}>
                    {label("remove", "remove", "removing")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className={`space-y-2 ${view.configured ? "" : "opacity-50"}`}>
            <Step n={2} text={t("step2")} />
            {!view.configured ? null : view.linked ? (
              <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm">✓ {t("linked", { who: view.linked_username ? `@${view.linked_username}` : "Telegram" })}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} disabled={busy !== null} onClick={() => void linkStart()}>
                    {label("linkStart", "relink", "linkStarting")}
                  </button>
                  <button type="button" className={BTN} disabled={busy !== null} onClick={() => void unlink()}>
                    {label("unlink", "unlink", "unlinking")}
                  </button>
                </div>
              </div>
            ) : linkUrl ? (
              <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
                <a href={linkUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-[var(--color-accent)] underline">
                  {t("linkOpen")}
                </a>
                <p className="text-xs text-[var(--color-muted)]">{t("linkHelp")}</p>
                <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void linkCheck()}>
                  {label("linkCheck", "linkCheck", "linkChecking")}
                </button>
              </div>
            ) : (
              <button type="button" className={BTN_PRIMARY} disabled={busy !== null || testFailed} onClick={() => void linkStart()}>
                {label("linkStart", "linkStart", "linkStarting")}
              </button>
            )}
          </div>
        </>
      )}

      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`text-xs ${notice.kind === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
