"use client";

import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import {
  TIMEOUT_MAX_SECONDS,
  TIMEOUT_MIN_SECONDS,
  parseTimeoutInput,
  timeoutRows,
  type ModelTimeoutChange,
  type ModelTimeoutRow,
  type ModelTimeoutsState,
} from "@/lib/model-timeouts";
import { useAction } from "@/lib/use-action";

async function detailOf(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function putTimeout(change: ModelTimeoutChange): Promise<ModelTimeoutsState> {
  const res = await fetch("/api/model-timeouts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!res.ok) throw new Error(await detailOf(res));
  return (await res.json()) as ModelTimeoutsState;
}

const INPUT =
  "w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm";
const SAVE =
  "inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

function TimeoutRow({
  row,
  range,
  onSaved,
}: {
  row: ModelTimeoutRow;
  range: { min: number; max: number };
  onSaved: (state: ModelTimeoutsState) => void;
}) {
  const t = useT("settings");
  const [value, setValue] = useState(row.timeout_seconds === null ? "" : String(row.timeout_seconds));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const parsed = parseTimeoutInput(value, range.min, range.max);
  const unchanged = parsed === row.timeout_seconds;
  const save = useAction(async () => {
    if (parsed === undefined) return;
    setError(null);
    setSaved(false);
    try {
      onSaved(await putTimeout({ provider: row.provider, model: row.model, timeout_seconds: parsed }));
      setSaved(true);
    } catch (err) {
      setError(t("modelTimeouts.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    }
  });
  const label = row.model ?? t("modelTimeouts.allModels");
  return (
    <li
      data-row={`${row.provider}/${row.model ?? "*"}`}
      className={`flex flex-wrap items-end gap-2 py-2 ${row.model === null ? "" : "pl-4"}`}
    >
      <form
        className="flex w-full flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate font-medium">
            {row.model === null ? row.provider : label}
          </div>
          <div className="truncate text-xs text-[var(--color-muted)]">
            {row.model === null
              ? t("modelTimeouts.providerWide")
              : row.used_by.length
                ? t("modelTimeouts.usedBy", { uses: row.used_by.join(", ") })
                : t("modelTimeouts.notInUse")}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="sr-only">{t("modelTimeouts.secondsFor", { name: `${row.provider} ${label}` })}</span>
          <input
            type="number"
            inputMode="numeric"
            min={range.min}
            max={range.max}
            placeholder={t("modelTimeouts.default")}
            value={value}
            aria-invalid={parsed === undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            className={INPUT}
          />
        </label>
        <ActionButton
          type="submit"
          busy={save.pending}
          busyLabel={t("aquarium.idle.saving")}
          disabled={parsed === undefined || unchanged}
          className={SAVE}
        >
          {parsed === null && row.timeout_seconds !== null ? t("modelTimeouts.clear") : t("aquarium.idle.save")}
        </ActionButton>
      </form>
      {parsed === undefined ? (
        <p role="alert" className="w-full text-xs text-[var(--color-danger)]">
          {t("modelTimeouts.invalid", range)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="w-full text-xs text-[var(--color-success)]">
          {t("aquarium.idle.saved")}
        </p>
      ) : null}
    </li>
  );
}

function AddTimeout({
  range,
  onSaved,
}: {
  range: { min: number; max: number };
  onSaved: (state: ModelTimeoutsState) => void;
}) {
  const t = useT("settings");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const parsed = parseTimeoutInput(value, range.min, range.max);
  const ready = provider.trim() !== "" && typeof parsed === "number";
  const add = useAction(async () => {
    if (!ready) return;
    setError(null);
    try {
      onSaved(
        await putTimeout({
          provider: provider.trim(),
          model: model.trim() || null,
          timeout_seconds: parsed as number,
        }),
      );
      setProvider("");
      setModel("");
      setValue("");
    } catch (err) {
      setError(t("modelTimeouts.saveFailed", { error: err instanceof Error ? err.message : "?" }));
    }
  });
  return (
    <form
      data-form="model-timeout-add"
      className="mt-4 flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void add.run();
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span>{t("modelTimeouts.add.provider")}</span>
        <input
          type="text"
          autoComplete="off"
          value={provider}
          placeholder="opencode-go"
          onChange={(e) => setProvider(e.target.value)}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        />
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span>{t("modelTimeouts.add.model")}</span>
        <input
          type="text"
          autoComplete="off"
          value={model}
          placeholder={t("modelTimeouts.allModels")}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t("modelTimeouts.add.seconds")}</span>
        <input
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={INPUT}
        />
      </label>
      <ActionButton type="submit" busy={add.pending} busyLabel={t("aquarium.idle.saving")} disabled={!ready} className={SAVE}>
        {t("modelTimeouts.add.submit")}
      </ActionButton>
      {error ? (
        <p role="alert" className="w-full text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Settings → Model timeouts: how long a model API call may take, per
 * provider and per model. Applies to chat turns, background tasks and
 * fallbacks in every profile. Owner/admin only.
 */
export function ModelTimeoutsSettings() {
  const t = useT("settings");
  const [state, setState] = useState<ModelTimeoutsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/model-timeouts", { cache: "no-store", signal: ac.signal });
        if (!res.ok) throw new Error(await detailOf(res));
        const body = (await res.json()) as ModelTimeoutsState;
        if (!ac.signal.aborted) setState(body);
      } catch (err) {
        if (!ac.signal.aborted) setLoadError(err instanceof Error ? err.message : "?");
      }
    })();
    return () => ac.abort();
  }, []);

  const range = {
    min: state?.min_seconds ?? TIMEOUT_MIN_SECONDS,
    max: state?.max_seconds ?? TIMEOUT_MAX_SECONDS,
  };
  return (
    <section
      data-section="model-timeouts"
      data-component="ModelTimeoutsSettings"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-base font-semibold">{t("modelTimeouts.title")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">{t("modelTimeouts.hint", range)}</p>
      {loadError ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {t("modelTimeouts.loadFailed", { error: loadError })}
        </p>
      ) : state === null ? (
        <Spinner />
      ) : (
        <>
          {timeoutRows(state).length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{t("modelTimeouts.empty")}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {timeoutRows(state).map((row) => (
                <TimeoutRow
                  key={`${row.provider}/${row.model ?? "*"}/${row.timeout_seconds ?? ""}`}
                  row={row}
                  range={range}
                  onSaved={setState}
                />
              ))}
            </ul>
          )}
          <AddTimeout range={range} onSaved={setState} />
        </>
      )}
    </section>
  );
}
