"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { Sheet, secondaryButtonClass } from "@/components/ui/Sheet";
import { useRefresh, useServerState } from "@/components/ui/useRefresh";
import { useLocale, useT } from "@/i18n";
import type { SiteRefreshMode, SiteRun, SiteTable } from "@/types/sites";

import { JSON_HEADERS, formatWhen, readJson, runTone, sitePath } from "./format";

/** Runs: what each refresh did, and Refresh now (incremental or full) for admins. */
export function RunsTab({
  siteId,
  runs: initialRuns,
  tables,
  canManage,
  canRefresh,
  defaultMode,
}: {
  siteId: string;
  runs: SiteRun[];
  tables: SiteTable[];
  canManage: boolean;
  canRefresh: boolean;
  defaultMode: SiteRefreshMode;
}) {
  const t = useT("sites");
  const locale = useLocale();
  const { refresh, refreshing } = useRefresh();
  const [runs, setRuns] = useServerState(initialRuns);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div data-component="RunsTab" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <ActionButton
            disabled={!canRefresh}
            onAction={() => setOpen(true)}
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {t("runs.refreshNow")}
          </ActionButton>
        ) : null}
        <ActionButton busy={refreshing} onAction={refresh} className={secondaryButtonClass}>
          {t("runs.reload")}
        </ActionButton>
        {canManage && !canRefresh ? <span className="text-xs text-[var(--color-muted)]">{t("runs.needsDesign")}</span> : null}
      </div>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {runs.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-muted)]">
          {t("runs.none")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-muted)]">
              <tr>
                {(["started", "mode", "trigger", "status", "pages", "inserted", "updated", "removed", "versions"] as const).map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-normal">
                    {t(`runs.col.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
                  <td className="whitespace-nowrap px-3 py-1.5">{formatWhen(r.started_at, locale)}</td>
                  <td className="px-3 py-1.5">{t(`mode.${r.mode}`)}</td>
                  <td className="px-3 py-1.5">{t(`trigger.${r.trigger}`)}</td>
                  <td className="px-3 py-1.5">
                    <Pill tone={runTone(r.status)}>{t(`runStatus.${r.status}`)}</Pill>
                    {r.error ? <div className="mt-1 max-w-xs text-red-400">{r.error}</div> : null}
                  </td>
                  <td className="px-3 py-1.5">{r.pages}</td>
                  <td className="px-3 py-1.5">{r.inserted}</td>
                  <td className="px-3 py-1.5">{r.updated}</td>
                  <td className="px-3 py-1.5">{r.removed}</td>
                  <td className="px-3 py-1.5">{r.versions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? (
        <RefreshSheet
          siteId={siteId}
          tables={tables}
          defaultMode={defaultMode}
          onClose={() => setOpen(false)}
          onStarted={(run) => {
            setOpen(false);
            setError(null);
            setRuns((prev) => [run, ...prev.filter((x) => x.id !== run.id)]);
            refresh();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function RefreshSheet({
  siteId,
  tables,
  defaultMode,
  onClose,
  onStarted,
  onError,
}: {
  siteId: string;
  tables: SiteTable[];
  defaultMode: SiteRefreshMode;
  onClose(): void;
  onStarted(run: SiteRun): void;
  onError(message: string): void;
}) {
  const t = useT("sites");
  const [mode, setMode] = useState<SiteRefreshMode>(defaultMode);
  const [picked, setPicked] = useState<string[]>(tables.map((x) => x.name));
  const all = picked.length === tables.length;

  async function start() {
    try {
      const body: { mode: SiteRefreshMode; entities?: string[] } = { mode };
      if (!all) body.entities = picked;
      const { run } = await readJson<{ run: SiteRun }>(
        await fetch(sitePath(siteId, "refresh"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }),
      );
      onStarted(run);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      onClose();
    }
  }

  return (
    <Sheet
      title={t("runs.refreshTitle")}
      onClose={onClose}
      component="SiteRefreshSheet"
      footer={
        <>
          <ActionButton
            onAction={start}
            disabled={picked.length === 0}
            busyLabel={t("runs.starting")}
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {t("runs.start")}
          </ActionButton>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {t("common.cancel")}
          </button>
        </>
      }
    >
      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1 font-medium">{t("runs.mode")}</legend>
        {(["incremental", "full"] as const).map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <span className="font-medium">{t(`mode.${m}`)}</span>
              <span className="block text-xs text-[var(--color-muted)]">{t(`runs.modeHint.${m}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {tables.length > 1 ? (
        <fieldset className="mt-4 space-y-1 text-sm">
          <legend className="mb-1 font-medium">{t("runs.entities")}</legend>
          {tables.map((x) => (
            <label key={x.name} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.includes(x.name)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, x.name] : p.filter((n) => n !== x.name)))
                }
              />
              <span className="font-mono text-xs">{x.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </Sheet>
  );
}
