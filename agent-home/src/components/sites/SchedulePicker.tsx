"use client";

import { inputClass } from "@/components/ui/Sheet";
import { useT } from "@/i18n";

import type { SchedulePreset } from "./format";

const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Off / every N hours / daily / weekly / custom cron, in the viewer's local time. */
export function SchedulePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: SchedulePreset;
  onChange(next: SchedulePreset): void;
  disabled?: boolean;
}) {
  const t = useT("sites");
  return (
    <div data-component="SchedulePicker" className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t("schedule.frequency")}
        className={`${inputClass} w-auto`}
        value={value.kind}
        disabled={disabled}
        onChange={(e) => {
          const kind = e.target.value as SchedulePreset["kind"];
          if (kind === "off") onChange({ kind });
          else if (kind === "hours") onChange({ kind, every: 6 });
          else if (kind === "daily") onChange({ kind, time: "06:00" });
          else if (kind === "weekly") onChange({ kind, day: 1, time: "06:00" });
          else onChange({ kind, cron: "" });
        }}
      >
        {(["off", "hours", "daily", "weekly", "custom"] as const).map((k) => (
          <option key={k} value={k}>
            {t(`schedule.kind.${k}`)}
          </option>
        ))}
      </select>
      {value.kind === "hours" ? (
        <label className="flex items-center gap-2 text-sm">
          {t("schedule.every")}
          <input
            type="number"
            min={1}
            max={23}
            aria-label={t("schedule.hours")}
            className={`${inputClass} w-20`}
            value={value.every}
            disabled={disabled}
            onChange={(e) => onChange({ kind: "hours", every: Number(e.target.value) || 1 })}
          />
          {t("schedule.hoursUnit")}
        </label>
      ) : null}
      {value.kind === "weekly" ? (
        <select
          aria-label={t("schedule.day")}
          className={`${inputClass} w-auto`}
          value={value.day}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, day: Number(e.target.value) })}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {t(`schedule.days.${d}`)}
            </option>
          ))}
        </select>
      ) : null}
      {value.kind === "daily" || value.kind === "weekly" ? (
        <input
          type="time"
          aria-label={t("schedule.time")}
          className={`${inputClass} w-auto`}
          value={value.time}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
        />
      ) : null}
      {value.kind === "custom" ? (
        <input
          aria-label={t("schedule.cron")}
          placeholder="0 6 * * 1-5"
          className={`${inputClass} w-48 font-mono`}
          value={value.cron}
          disabled={disabled}
          onChange={(e) => onChange({ kind: "custom", cron: e.target.value })}
        />
      ) : null}
    </div>
  );
}
