"use client";

import { useCallback, useEffect, useState } from "react";

import { errorMessage } from "@/components/users/api";
import { Spinner } from "@/components/ui/Spinner";

import { changePassword, loadSecurity, twoFactor, type AccountSecurity as Security } from "./api";
import { RecoveryCodes } from "./RecoveryCodes";
import { TwoFactorSetup } from "./TwoFactorSetup";
import { card, errorText, field, okBox, primary, secondary } from "./ui";
import { useAccountT, type AccountT } from "./useAccountT";

const MIN_PASSWORD_LENGTH = 12;

type Panel = "none" | "password" | "setup" | "off" | "codes";

/**
 * Settings block for the signed-in person's own login (Get ready item 1):
 * change password, turn two-factor login on/off, make new recovery codes.
 * Everything is inline; every change is re-checked by the server.
 */
export function AccountSecurity({ isOwner = false }: { isOwner?: boolean }) {
  const t = useAccountT();
  const [security, setSecurity] = useState<Security | null>(null);
  const [failed, setFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>("none");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    loadSecurity()
      .then((s) => {
        setSecurity(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(refresh, [refresh]);

  const enabled = security?.two_factor.enabled ?? false;
  const open = (next: Panel) => {
    setNotice(null);
    setPanel((cur) => (cur === next ? "none" : next));
  };
  const finish = (message: string | null) => {
    setPanel("none");
    setNotice(message);
    refresh();
  };

  return (
    <section data-section="account" data-component="AccountSecurity" className={card}>
      <h2 className="text-base font-semibold">{isOwner ? t("title") : t("titleMember")}</h2>
      {failed ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{t("loadFailed")}</p>
      ) : !security ? (
        <p aria-busy="true" className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <Spinner /> {t("loading")}
        </p>
      ) : (
        <>
          <p className="mt-1 text-xs text-[var(--color-muted)]" data-testid="account-status">
            {t("status", { email: security.email || "—", state: enabled ? t("stateOn") : t("stateOff") })}
            {enabled ? ` · ${t("codesLeft", { n: security.two_factor.recovery_codes_left })}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => open("password")} aria-expanded={panel === "password"} className={secondary}>
              {t("changePassword")}
            </button>
            {enabled ? (
              <button type="button" onClick={() => open("codes")} aria-expanded={panel === "codes"} className={secondary}>
                {t("newRecoveryCodes")}
              </button>
            ) : null}
            <label className="ml-auto flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t("twoFactor")}
                onClick={() => open(enabled ? "off" : "setup")}
                className={`relative h-6 w-11 rounded-full transition ${
                  enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)] border border-[var(--color-border)]"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${enabled ? "left-[22px]" : "left-0.5"}`}
                />
              </button>
              <span>{t("twoFactor")}</span>
            </label>
          </div>
          {notice ? <p className={`mt-3 ${okBox}`}>{notice}</p> : null}
          <div className="mt-3 empty:hidden">
            {panel === "password" ? (
              <PasswordPanel t={t} needsCode={enabled} onDone={() => finish(t("passwordSaved"))} onCancel={() => setPanel("none")} />
            ) : null}
            {panel === "setup" ? (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-[var(--color-muted)]">{t("s2Desc")}</p>
                <TwoFactorSetup t={t} onDone={() => finish(null)} onCancel={() => finish(null)} />
              </div>
            ) : null}
            {panel === "off" ? (
              <ConfirmPanel
                t={t}
                help={t("turnOffHelp")}
                action={t("turnOff")}
                run={async (password, code) => {
                  await twoFactor("disable", { password, code });
                  finish(t("turnedOff"));
                }}
                onCancel={() => setPanel("none")}
              />
            ) : null}
            {panel === "codes" ? <NewCodesPanel t={t} onClose={() => finish(null)} /> : null}
          </div>
        </>
      )}
    </section>
  );
}

function PasswordPanel({
  t,
  needsCode,
  onDone,
  onCancel,
}: {
  t: AccountT;
  needsCode: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    if (busy) return;
    if (next.length < MIN_PASSWORD_LENGTH) return setError(t("passwordShort"));
    if (next !== again) return setError(t("passwordMismatch"));
    setBusy(true);
    setError(null);
    try {
      await changePassword({ current_password: current, new_password: next, code: needsCode ? code : "" });
      onDone();
    } catch (err) {
      setError(errorMessage(err, t("failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form data-component="ChangePassword" onSubmit={submit} aria-busy={busy} className="grid gap-2 sm:grid-cols-2">
      <Labeled label={t("currentPassword")}>
        <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
      </Labeled>
      {needsCode ? (
        <Labeled label={t("codeLabel")}>
          <input autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className={`${field} font-mono`} />
        </Labeled>
      ) : (
        <span className="hidden sm:block" />
      )}
      <Labeled label={t("newPassword")}>
        <input type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
      </Labeled>
      <Labeled label={t("confirmPassword")}>
        <input type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={field} />
      </Labeled>
      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">{t("passwordHint")}</p>
      {error ? <p role="alert" className={`${errorText} sm:col-span-2`}>{error}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={busy} className={primary}>
          {busy ? <><Spinner /> {t("saving")}</> : t("save")}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondary}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function ConfirmPanel({
  t,
  help,
  action,
  run,
  onCancel,
}: {
  t: AccountT;
  help: string;
  action: string;
  run: (password: string, code: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(evt: React.FormEvent) {
    evt.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(password, code);
    } catch (err) {
      setError(errorMessage(err, t("failed")));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={busy} className="grid gap-2 sm:grid-cols-2">
      <p className="text-xs text-[var(--color-muted)] sm:col-span-2">{help}</p>
      <Labeled label={t("currentPassword")}>
        <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
      </Labeled>
      <Labeled label={t("codeLabel")}>
        <input autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className={`${field} font-mono`} />
      </Labeled>
      {error ? <p role="alert" className={`${errorText} sm:col-span-2`}>{error}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={busy} className={primary}>
          {busy ? <><Spinner /> {t("checking")}</> : action}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondary}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function NewCodesPanel({ t, onClose }: { t: AccountT; onClose: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  if (codes) {
    return (
      <div className="flex flex-col gap-2">
        <RecoveryCodes codes={codes} t={t} />
        <div>
          <button type="button" onClick={onClose} className={primary}>
            {t("done")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <ConfirmPanel
      t={t}
      help={t("newCodesHelp")}
      action={t("make")}
      run={async (password, code) => {
        const res = await twoFactor("recovery-codes", { password, code });
        setCodes(res.recovery_codes ?? []);
      }}
      onCancel={onClose}
    />
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
