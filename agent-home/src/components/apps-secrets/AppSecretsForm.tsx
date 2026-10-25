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
  type AppSecretsResult,
  MANAGED_SECRET_NAMES,
  secretNameProblem,
  secretValueProblem,
} from "@/components/apps-secrets/rules";
import { ActionButton } from "@/components/projects/ActionButton";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/i18n";

export interface AppSecretsFormProps {
  /** The app's slug (tools.name). */
  name: string;
  mode: AppMode;
  /** Names already set for this mode (tools.secret_names / helper status). */
  secretNames: readonly string[];
  /** False for viewers and people who may not act on this app. */
  canEdit?: boolean;
}

export function secretsPath(app: string): string {
  return `/api/tools/apps/${encodeURIComponent(app)}/secrets`;
}

const inputCls =
  "w-full rounded-xl border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm";

export function AppSecretsForm({ name, mode, secretNames, canEdit = true }: AppSecretsFormProps) {
  const t = useT("appSecrets");
  const save = useProjectAction<AppSecretsResult>();
  const remove = useProjectAction<AppSecretsResult>();
  const [names, setNames] = useState<string[]>(() => [...secretNames].sort());
  const [secretName, setSecretName] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; restart: boolean } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const applyResult = (result: AppSecretsResult) => setNames([...result.secret_names].sort());

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
      onSuccess: applyResult,
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
      <div>
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-xs text-[var(--color-muted)]">
          {t(mode === "prod" ? "introProd" : "introDev")}
        </p>
      </div>

      {names.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">{t("none")}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-sm" aria-label={t("listLabel")}>
          {names.map((key) => (
            <li key={key} className="flex items-center justify-between gap-2 py-1.5">
              <code className="text-xs">{key}</code>
              {MANAGED_SECRET_NAMES.has(key) ? (
                <span className="text-xs text-[var(--color-muted)]">{t("managed")}</span>
              ) : canEdit ? (
                <button
                  type="button"
                  data-appmcp-deny="secret"
                  onClick={() => setRemoving(key)}
                  className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs"
                  aria-label={t("removeLabel", { name: key })}
                >
                  {t("remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
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
            <p role="alert" className="text-xs text-red-600">
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
