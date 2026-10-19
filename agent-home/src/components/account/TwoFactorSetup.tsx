"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { errorMessage } from "@/components/users/api";
import { Spinner } from "@/components/ui/Spinner";

import { groupKey, twoFactor } from "./api";
import { RecoveryCodes } from "./RecoveryCodes";
import { errorText, field, okBox, primary, secondary } from "./ui";
import type { AccountT } from "./useAccountT";

type Step = "password" | "scan" | "codes";

/**
 * Turn on two-factor login for the signed-in person: password → scan the QR /
 * type the key → check one code → save the ten recovery codes.
 *
 * Used inline by Settings (Get ready item 1) and as the optional step on the
 * first-run page, which passes the password just chosen so it isn't asked twice.
 */
export function TwoFactorSetup({
  t,
  password: knownPassword = "",
  onDone,
  onCancel,
  cancelLabel,
}: {
  t: AccountT;
  password?: string;
  onDone: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState(knownPassword);
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function start(pw: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await twoFactor("start", { password: pw });
      setSecret(res.secret ?? "");
      setQr(await QRCode.toDataURL(res.otpauth_uri ?? "", { margin: 1, width: 176 }));
      setPassword("");
      setStep("scan");
    } catch (err) {
      setError(errorMessage(err, t("failed")));
      setStep("password");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (knownPassword) void start(knownPassword);
    // Only once, with the password the first-run form just set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm(evt: React.FormEvent) {
    evt.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await twoFactor("confirm", { code });
      setCodes(res.recovery_codes ?? []);
      setStep("codes");
    } catch (err) {
      setError(errorMessage(err, t("codeWrong")));
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const cancel = onCancel ? (
    <button type="button" onClick={onCancel} disabled={busy} className={secondary}>
      {cancelLabel ?? t("cancel")}
    </button>
  ) : null;

  if (step === "password") {
    if (knownPassword && !error) {
      return (
        <p aria-busy="true" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Spinner /> {t("starting")}
        </p>
      );
    }
    return (
      <form
        data-component="TwoFactorStart"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void start(password);
        }}
        className="flex flex-col gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-muted)]">{t("passwordToStart")}</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${field} sm:max-w-xs`}
          />
        </label>
        {error ? <p role="alert" className={errorText}>{error}</p> : null}
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !password} className={primary}>
            {busy ? <><Spinner /> {t("starting")}</> : t("start")}
          </button>
          {cancel}
        </div>
      </form>
    );
  }

  return (
    <div data-component="TwoFactorSetup" className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <p className="font-semibold">{t("scan")}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- local data: URL */}
        {qr ? <img src={qr} alt="QR code" width={176} height={176} className="rounded-lg bg-white" /> : null}
        <p className="text-xs text-[var(--color-muted)]">{t("cantScan")}</p>
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          <code className="grow break-all font-mono text-xs" data-testid="totp-key">{groupKey(secret)}</code>
          <button type="button" onClick={copyKey} className={secondary}>
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-semibold">{t("typeCode")}</p>
        {step === "scan" ? (
          <form onSubmit={confirm} aria-busy={busy} className="flex flex-wrap gap-2">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={t("typeCode")}
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
              className={`${field} max-w-[150px] font-mono tracking-[0.2em]`}
            />
            <button type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6} className={secondary}>
              {busy ? <><Spinner /> {t("checking")}</> : t("checkCode")}
            </button>
          </form>
        ) : (
          <>
            <p className={okBox}>{t("codeOk")}</p>
            <p className="mt-2 font-semibold">{t("saveCodes")}</p>
            <RecoveryCodes codes={codes} t={t} />
            <div>
              <button type="button" onClick={onDone} className={primary}>
                {t("done")}
              </button>
            </div>
          </>
        )}
        {error ? <p role="alert" className={errorText}>{error}</p> : null}
        {step === "scan" && cancel ? <div>{cancel}</div> : null}
      </div>
    </div>
  );
}
