"use client";

/**
 * Secrets of one local app instance (FG-33 §3.6, P8-2 2.7). The person types
 * a value here, never in chat: it goes browser → BFF → Python API → root
 * helper (`set-secret`) and comes back as names only. The agent can see the
 * names (`tools.secret_names`) but never a value: the value field is a
 * password input (app-mcp snapshots skip it) and the whole form sits in a
 * `data-appmcp-deny` region, so app-mcp can neither fill nor submit it.
 */
import { useState, type FormEvent } from "react";

import {
  type AppMode,
  type AppSecretMeta,
  type AppSecretsResult,
  MANAGED_SECRET_NAMES,
  secretNameProblem,
  secretValueProblem,
} from "@/components/apps-secrets/rules";
import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { timeAgo } from "@/components/tools/timeAgo";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InfoTip } from "@/components/ui/InfoTip";
import { Pill } from "@/components/ui/Pill";
import { useLocale, useT } from "@/i18n";

export interface AppSecretsFormProps {
  /** The app's slug (tools.name). */
  name: string;
  mode: AppMode;
  /** Names already set for this mode (tools.secret_names / helper status). */
  secretNames: readonly string[];
  /** When each was last set (GET /api/tools/{name} `secrets`); never a value. */
  secrets?: readonly AppSecretMeta[];
  /** False for viewers and people who may not act on this app. */
  canEdit?: boolean;
}

export function secretsPath(app: string): string {
  return `/api/tools/apps/${encodeURIComponent(app)}/secrets`;
}

const MASK = "••••••••";

function mergeRows(names: readonly string[], meta: readonly AppSecretMeta[] | undefined,
                   prior: readonly AppSecretMeta[] = []): AppSecretMeta[] {
  const when = new Map<string, string | null>(prior.map((r) => [r.name, r.updated_at]));
  for (const r of meta ?? []) when.set(r.name, r.updated_at);
  return [...new Set(names)].sort().map((n) => ({ name: n, updated_at: when.get(n) ?? null }));
}

const inputCls =
  "w-full rounded-xl border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm";

export function AppSecretsForm({ name, mode, secretNames, secrets, canEdit = true }: AppSecretsFormProps) {
  const t = useT("appSecrets");
  const locale = useLocale();
  const save = useProjectAction<AppSecretsResult>();
  const remove = useProjectAction<AppSecretsResult>();
  const [rows, setRows] = useState<AppSecretMeta[]>(() => mergeRows(secretNames, secrets));
  const [managing, setManaging] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; restart: boolean } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const applyResult = (result: AppSecretsResult) =>
    setRows((prior) => mergeRows(result.secret_names, result.secrets, prior));

  async function onSave(event?: FormEvent) {
    event?.preventDefault();
    const key = secretName.trim();
    const nameProblem = secretNameProblem(key);
    if (nameProblem) {
      setProblem(t(`nameProblem.${nameProblem}`));
      return;
    }
    const valueProblem = secretValueProblem(value);
    if (valueProblem) {
      setProblem(t(`valueProblem.${valueProblem}`));
      return;
    }
    setProblem(null);
    setSaved(null);
    const result = await save.run(secretsPath(name), {
      method: "PUT",
      body: { mode, name: key, value },
      onSuccess: (r) =>
        applyResult(r.secrets ? r : { ...r, secrets: [{ name: key, updated_at: new Date().toISOString() }] }),
    });
    if (result?.ok) {
      setValue("");
      setSecretName("");
      setSaved({ name: key, restart: result.data?.restart_needed === true });
    }
  }

  async function onRemove(key: string) {
    setSaved(null);
    const result = await remove.run(secretsPath(name), {
      method: "PUT",
      body: { mode, name: key, delete: true },
      onSuccess: applyResult,
    });
    if (result?.ok) {
      setRemoving(null);
      if (result.data?.restart_needed) setSaved({ name: key, restart: true });
    }
  }

  return (
    <section
      data-component="AppSecretsForm"
      data-appmcp-deny="secret"
      aria-label={t("title")}
      className="space-y-3"
    >
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("title")}
        </h3>
        <InfoTip label={t("infoLabel")}>
          {t("info")} {t(mode === "prod" ? "introProd" : "introDev")}
        </InfoTip>
        <span className="ml-auto">
          <Pill>{t("ownerOnly")}</Pill>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{t("none")}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-sm" aria-label={t("listLabel")}>
          {rows.map(({ name: key, updated_at }) => {
            const when = timeAgo(updated_at, locale);
            return (
              <li
                key={key}
                data-secret={key}
                className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-x-3 gap-y-1 py-2.5"
              >
                <code className="font-sans text-sm text-[var(--color-muted)] [overflow-wrap:anywhere]">{key}</code>
                <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  {MANAGED_SECRET_NAMES.has(key) ? (
                    <span className="text-xs text-[var(--color-muted)]">{t("managed")}</span>
                  ) : (
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span aria-label={t("valueHidden")} className="tracking-widest">{MASK}</span>
                      {when ? (
                        <time dateTime={updated_at ?? undefined} suppressHydrationWarning>
                          {` · ${t("setAgo", { when })}`}
                        </time>
                      ) : null}
                    </span>
                  )}
                  {managing && canEdit && !MANAGED_SECRET_NAMES.has(key) ? (
                    <button
                      type="button"
                      data-appmcp-deny="secret"
                      onClick={() => setRemoving(key)}
                      disabled={remove.busy}
                      className="min-h-[36px] rounded-full border border-[var(--color-border)] px-3 text-xs disabled:opacity-50"
                      aria-label={t("removeLabel", { name: key })}
                    >
                      {t("remove")}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <button
          type="button"
          data-appmcp-deny="secret"
          aria-expanded={managing}
          onClick={() => setManaging((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl px-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <KeyGlyph />
          {managing ? t("manageDone") : t("manage")}
        </button>
      ) : null}

      {canEdit && managing ? (
        <form onSubmit={onSave} className="space-y-2" autoComplete="off" noValidate>
          <label className="block space-y-1 text-xs">
            <span>{t("nameLabel")}</span>
            <input
              value={secretName}
              onChange={(e) => setSecretName(e.target.value.toUpperCase())}
              placeholder="MY_API_KEY"
              autoComplete="off"
              spellCheck={false}
              className={inputCls}
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("valueLabel")}</span>
            <input
              type="password"
              name="secret_value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              className={inputCls}
            />
          </label>
          {problem || save.error ? (
            <p role="alert" className="text-xs text-[var(--color-danger)]">
              {problem ?? save.error}
            </p>
          ) : null}
          <ActionButton
            type="submit"
            busy={save.busy}
            pendingLabel={t("saving")}
            data-appmcp-deny="secret"
          >
            {t("save")}
          </ActionButton>
        </form>
      ) : null}

      {saved ? (
        <p role="status" className="text-xs text-[var(--color-muted)]">
          {saved.restart ? t("savedRestart", { name: saved.name }) : t("saved", { name: saved.name })}
        </p>
      ) : null}

      {removing ? (
        <div data-appmcp-deny="secret">
          <ConfirmDialog
            title={t("removeTitle", { name: removing })}
            body={remove.error ?? t("removeBody", { name: removing })}
            confirmLabel={t("remove")}
            cancelLabel={t("cancel")}
            busy={remove.busy}
            onConfirm={() => onRemove(removing)}
            onCancel={() => {
              remove.clearError();
              setRemoving(null);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function KeyGlyph() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2M16 7l3 3M18 5l2 2" />
    </svg>
  );
}
