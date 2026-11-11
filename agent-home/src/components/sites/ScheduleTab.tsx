"use client";

import { useState, useSyncExternalStore } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { inputClass } from "@/components/ui/Sheet";
import { useRefresh } from "@/components/ui/useRefresh";
import { useLocale, useT } from "@/i18n";
import type { SiteRefreshMode, SiteSource } from "@/types/sites";

import { SchedulePicker } from "./SchedulePicker";
import {
  JSON_HEADERS,
  cronToPreset,
  formatWhen,
  nextCronRun,
  presetToCron,
  readJson,
  sitePath,
  type DesignEntity,
  type SchedulePreset,
} from "./format";

const noSubscribe = () => () => {};
const localOffset = () => new Date().getTimezoneOffset();

/** Schedule: when the site refreshes on its own, the default mode, and each table's plan. */
export function ScheduleTab({
  site,
  entities,
  canManage,
}: {
  site: SiteSource;
  entities: DesignEntity[];
  canManage: boolean;
}) {
  const t = useT("sites");
  const locale = useLocale();
  const { refresh } = useRefresh();
  // Presets are in the viewer's local time; the server render has no browser, so UTC.
  const offset = useSyncExternalStore(noSubscribe, localOffset, () => 0);
  const [edited, setEdited] = useState<SchedulePreset | null>(null);
  const preset = edited ?? cronToPreset(site.schedule_cron, offset);
  const [mode, setMode] = useState<SiteRefreshMode>(site.default_refresh_mode);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cron = presetToCron(preset, offset);
  const next = nextCronRun(cron, new Date());
  const dirty = cron !== (site.schedule_cron ?? null) || mode !== site.default_refresh_mode;

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await readJson(
        await fetch(sitePath(site.id), {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ schedule_cron: cron, default_refresh_mode: mode }),
        }),
      );
      setSaved(true);
      setEdited(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div data-component="ScheduleTab" className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-semibold">{t("schedule.title")}</h3>
        <SchedulePicker value={preset} onChange={setEdited} disabled={!canManage} />
        <label className="flex items-center gap-2 text-sm">
          {t("schedule.defaultMode")}
          <select
            className={`${inputClass} w-auto`}
            value={mode}
            disabled={!canManage}
            onChange={(e) => setMode(e.target.value as SiteRefreshMode)}
          >
            <option value="incremental">{t("mode.incremental")}</option>
            <option value="full">{t("mode.full")}</option>
          </select>
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          {cron
            ? next
              ? t("schedule.nextRun", { when: formatWhen(next.toISOString(), locale), cron })
              : t("schedule.cronOnly", { cron })
            : t("schedule.manualOnly")}
          {cron && site.status === "paused" ? ` ${t("schedule.pausedNote")}` : ""}
        </p>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {saved && !dirty ? <InlineAlert tone="success">{t("schedule.saved")}</InlineAlert> : null}
        {canManage ? (
          <ActionButton
            disabled={!dirty || (preset.kind === "custom" && !cron)}
            onAction={save}
            busyLabel={t("schedule.saving")}
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
          >
            {t("schedule.save")}
          </ActionButton>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">{t("schedule.readOnly")}</p>
        )}
      </section>
      {entities.length ? (
        <section className="space-y-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="text-sm font-semibold">{t("schedule.perTable")}</h3>
          <p className="text-xs text-[var(--color-muted)]">{t("schedule.perTableHint")}</p>
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pr-3 font-normal">{t("schedule.tableCol")}</th>
                <th className="py-1 pr-3 font-normal">{t("schedule.kindCol")}</th>
                <th className="py-1 pr-3 font-normal">{t("design.refresh")}</th>
                <th className="py-1 font-normal">{t("schedule.fullEveryCol")}</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((e) => (
                <tr key={e.name} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-3 font-mono">{e.name}</td>
                  <td className="py-1 pr-3">
                    <Pill tone={e.kind === "fixed" ? "accent" : "muted"}>{t(`kind.${e.kind}`)}</Pill>
                  </td>
                  <td className="py-1 pr-3">{t(`mode.${e.refresh.mode === "full" ? "full" : "incremental"}`)}</td>
                  <td className="py-1">{e.refresh.full_every ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
