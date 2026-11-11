"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { EyeIcon, EyeOffIcon, LockIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import {
  formatCountdown,
  isSecretName,
  secondsLeft,
  secretRef,
  SecretSubmitError,
  slugifySecretName,
  type SecretErrorCode,
} from "@/lib/chat/secret-prompt";
import { useNow } from "@/lib/use-now";
import type { ChatSecretRequest } from "@/types";

export interface SecretRequestModalProps {
  /** `request` answers an agent `secret.request`; `save` stores a volunteered secret. */
  mode: "request" | "save";
  /** Required in `request` mode. */
  request?: ChatSecretRequest | null;
  /** `save` mode: starting name and value (e.g. text moved out of the composer). */
  initialName?: string;
  initialValue?: string;
  /**
   * Send the values. The modal clears its fields *before* this runs, so a
   * value never outlives the send in React state. Throw `SecretSubmitError`
   * to show a translated error line.
   */
  onSubmit(values: Record<string, string>, name: string): Promise<void>;
  /** `request` mode: decline the request (the agent is told the person declined). */
  onDecline?(): Promise<void>;
  /** Close without answering. In `request` mode the request stays pending. */
  onDismiss(): void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Attributes that keep browsers and password managers away from the field. */
const NO_AUTOFILL = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** Drop the line break a paste from a terminal or file often carries. */
function trimPaste(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function MaskedField({
  id,
  label,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  autoFocus?: boolean;
}) {
  const t = useT("secretPrompt");
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-3">
      <label htmlFor={id} className="text-xs font-medium text-[var(--color-muted)]">
        {label}
      </label>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          id={id}
          name={`${id}-masked`}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          aria-describedby={`${id}-hint`}
          className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-sm"
          {...NO_AUTOFILL}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-controls={id}
          aria-label={shown ? t("field.hide") : t("field.show")}
          title={shown ? t("field.hide") : t("field.show")}
          onClick={() => setShown((s) => !s)}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      <p id={`${id}-hint`} className="mt-1 text-[11px] text-[var(--color-muted)]">
        {t("field.masked")}
      </p>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-20 shrink-0 text-[var(--color-muted)]">{term}</dt>
      <dd className="min-w-0 break-words text-[var(--color-fg)]">{children}</dd>
    </div>
  );
}

/**
 * The masked popup for FG-37 secrets. Secrets never travel as chat text: the
 * value goes from these `type="password"` fields straight to the BFF over
 * HTTPS and the agent learns only the name.
 *
 * A dialog with a focus trap; Esc and "Not now" close it **without**
 * declining, so an agent request stays pending and can be reopened from its
 * card. Decline is an explicit button.
 */
export function SecretRequestModal({
  mode,
  request,
  initialName = "",
  initialValue = "",
  onSubmit,
  onDecline,
  onDismiss,
}: SecretRequestModalProps) {
  const t = useT("secretPrompt");
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isRequest = mode === "request" && !!request;
  const isPassword = isRequest && request!.kind === "password";

  const [name, setName] = useState(initialName);
  const [username, setUsername] = useState(request?.username ?? "");
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SecretErrorCode | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const now = useNow(isRequest && request!.expiresAt !== null);
  const left = isRequest ? secondsLeft(request!.expiresAt, now) : null;
  const expired = left === 0;

  useEffect(() => {
    const previous = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      opener?.focus?.();
    };
  }, []);

  const nameOk = isRequest || isSecretName(name);
  const canSubmit = !busy && !expired && value.length > 0 && nameOk && (!isPassword || username.trim() !== "");

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onDismiss();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function submit() {
    if (!canSubmit) return;
    const secret = trimPaste(value);
    const values: Record<string, string> = isPassword
      ? { username: username.trim(), password: secret }
      : { value: secret };
    const targetName = isRequest ? request!.name : name;
    // Clear before sending: the value must not linger in state after it leaves.
    setValue("");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values, targetName);
    } catch (err) {
      setError(err instanceof SecretSubmitError ? err.code : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (busy || !onDecline) return;
    setValue("");
    setBusy(true);
    setError(null);
    try {
      await onDecline();
    } catch (err) {
      setError(err instanceof SecretSubmitError ? err.code : "failed");
    } finally {
      setBusy(false);
    }
  }

  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  return (
    <div
      data-component="SecretRequestModal"
      data-mode={mode}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        className="flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 pb-[calc(1rem+var(--safe-bottom))] sm:rounded-2xl sm:pb-4"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-[var(--color-fg)]">
          <LockIcon className="text-[var(--color-accent)]" />
          {isRequest ? t("request.title") : t("save.title")}
        </h2>
        <form
          className="mt-2 min-h-0 flex-1 overflow-y-auto"
          autoComplete="off"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p id={descId} className="text-sm text-[var(--color-muted)]">
            {isRequest ? t("request.intro") : t("save.intro", { ref: secretRef("name") })}
          </p>
          {isRequest ? (
            <>
              <p className="mt-3 text-sm font-semibold text-[var(--color-fg)]">{request!.label}</p>
              <dl className="mt-2 flex flex-col gap-1">
                {request!.purpose ? <Fact term={t("request.purpose")}>{request!.purpose}</Fact> : null}
                <Fact term={t("request.name")}>
                  <code className="font-mono text-xs">{request!.name}</code>
                </Fact>
              </dl>
              {isPassword ? (
                <div className="mt-3">
                  <label htmlFor={`${uid}-user`} className="text-xs font-medium text-[var(--color-muted)]">
                    {t("request.username")}
                  </label>
                  <input
                    id={`${uid}-user`}
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus={!request!.username}
                    className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm"
                    {...NO_AUTOFILL}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-3">
              <label htmlFor={`${uid}-name`} className="text-xs font-medium text-[var(--color-muted)]">
                {t("save.name")}
              </label>
              <input
                id={`${uid}-name`}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(slugifySecretName(e.target.value));
                  setNameTouched(true);
                }}
                onBlur={() => setNameTouched(true)}
                autoFocus={!initialName}
                aria-invalid={nameTouched && !nameOk}
                aria-describedby={`${uid}-name-hint`}
                className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-sm"
                {...NO_AUTOFILL}
              />
              <p
                id={`${uid}-name-hint`}
                className={`mt-1 text-[11px] ${nameTouched && !nameOk ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}
              >
                {nameTouched && !nameOk ? t("save.nameInvalid") : t("save.nameHint")}
              </p>
            </div>
          )}
          <MaskedField
            id={`${uid}-value`}
            label={isPassword ? t("request.password") : isRequest ? t("request.value") : t("save.value")}
            value={value}
            onChange={setValue}
            autoFocus={isRequest ? !isPassword || !!request!.username : !!initialName}
          />
          {left !== null ? (
            <p
              data-testid="secret-countdown"
              className={`mt-3 text-xs ${expired ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}
            >
              {expired ? t("request.expired") : t("request.expiresIn", { time: formatCountdown(left) })}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">
              {t(`error.${error}`)}
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2">
            {expired ? null : (
              <button
                type="submit"
                disabled={!canSubmit}
                aria-busy={busy}
                className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {isRequest ? t("request.submit") : t("save.submit")}
              </button>
            )}
            <div className="flex gap-2">
              {isRequest && onDecline && !expired ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decline()}
                  className="flex-1 rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-50"
                >
                  {t("request.decline")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={onDismiss}
                className="flex-1 rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm disabled:opacity-50"
              >
                {isRequest ? (expired ? t("request.close") : t("request.later")) : t("save.cancel")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
