"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import type { ProjectAutonomy, ProjectDetail } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

export const AUTONOMY_OPTIONS: {
  value: ProjectAutonomy;
  label: string;
  detail: string;
}[] = [
  {
    value: "manual",
    label: "Manual",
    detail: "Never runs by itself — you start every run; cards wait for you.",
  },
  {
    value: "supervised",
    label: "Supervised",
    detail: "Runs on its schedule, pauses at checkpoints, reports back.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    detail: "Runs and decides on its own; you review outputs after.",
  },
];

interface ScheduleAnswer {
  schedule?: string | null;
  next_run_at?: number | null;
  scheduled?: boolean;
}

const SCHEDULE_EXAMPLES = ["every 60m", "every 1d", "0 9 * * 1"];

/**
 * How and when the project runs: the schedule (repeatable projects only —
 * `PUT/DELETE /schedule`) and the autonomy level (`PATCH /autonomy`). Both
 * are chosen at creation and were frozen afterwards; a restore drops the
 * schedule on purpose, so this is also where it comes back.
 */
export function SettingsPanel({
  project,
  canLead,
  hasActivePlan,
}: {
  project: ProjectDetail;
  canLead: boolean;
  hasActivePlan: boolean;
}) {
  const timeLabel = useTimeLabel();
  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;
  const [schedule, setSchedule] = useState(project.schedule ?? "");
  const [autonomy, setAutonomy] = useState<ProjectAutonomy>(project.autonomy);
  const scheduleAction = useProjectAction<ScheduleAnswer>();
  const clearAction = useProjectAction<ScheduleAnswer>();
  const autonomyAction = useProjectAction();
  const busy = scheduleAction.busy || clearAction.busy || autonomyAction.busy;
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The write answers with the new schedule (or its removal); showing it
  // straight away means the summary never contradicts the "saved" note
  // while the server read catches up.
  const [current, setCurrent] = useState<{
    schedule: string | null;
    next_run_at: number | null;
  }>({
    schedule: project.schedule ?? null,
    next_run_at: project.next_run_at ?? null,
  });

  const showSchedule = (data: ScheduleAnswer) =>
    setCurrent((prev) =>
      data.scheduled === false
        ? { schedule: null, next_run_at: null }
        : {
            schedule: typeof data.schedule === "string" ? data.schedule : prev.schedule,
            next_run_at: typeof data.next_run_at === "number" ? data.next_run_at : null,
          },
    );

  const saveSchedule = () => {
    const value = schedule.trim();
    setSaved(null);
    if (!value) {
      setInvalid("Type a schedule — e.g. “every 60m” or a cron line.");
      return;
    }
    setInvalid(null);
    void scheduleAction.run(`${slugPath}/schedule`, {
      method: "PUT",
      body: { schedule: value },
      onSuccess: (data) => {
        showSchedule(data);
        setSaved("Schedule saved.");
      },
    });
  };

  const clearSchedule = () => {
    setSaved(null);
    setInvalid(null);
    void clearAction.run(`${slugPath}/schedule`, {
      method: "DELETE",
      onSuccess: (data) => {
        showSchedule({ ...data, scheduled: false });
        setSaved("Schedule removed — the project only runs when you start it.");
      },
    });
  };

  const saveAutonomy = () => {
    setSaved(null);
    void autonomyAction.run(`${slugPath}/autonomy`, {
      method: "PATCH",
      body: { autonomy },
      onSuccess: () => setSaved("Autonomy updated."),
    });
  };

  const readOnly = !canLead || project.archived;
  const repeatable = project.cadence === "repeatable";
  const inputClass =
    "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

  return (
    <section
      id="panel-settings"
      data-component="SettingsPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Settings
      </h2>

      <div className="mt-2 flex flex-col gap-1" data-component="ScheduleEditor">
        <span className="text-sm font-medium">Schedule</span>
        {repeatable ? (
          <>
            <p className="text-xs text-[var(--color-muted)]">
              {current.schedule
                ? current.next_run_at != null
                  ? `Runs ${current.schedule} · next ${timeLabel(current.next_run_at)}`
                  : `Runs ${current.schedule}`
                : "No schedule yet — a repeatable project needs one to fire on its own."}
              {current.schedule && !hasActivePlan
                ? " Scheduled runs will fail until a plan is active."
                : ""}
            </p>
            {readOnly ? null : (
              <form
                className="mt-1 flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveSchedule();
                }}
              >
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="every 60m"
                  aria-label="Schedule"
                  className={inputClass}
                  list="schedule-examples"
                />
                <datalist id="schedule-examples">
                  {SCHEDULE_EXAMPLES.map((example) => (
                    <option key={example} value={example} />
                  ))}
                </datalist>
                <p className="text-xs text-[var(--color-muted)]">
                  “every 30m”, “every 2h”, “every 1d”, or a 5-field cron line
                  like “0 9 * * 1” (Mondays at 09:00).
                </p>
                <div className="flex items-center gap-2">
                  <ActionButton
                    type="submit"
                    busy={scheduleAction.busy}
                    pendingLabel="Saving…"
                    disabled={busy}
                    className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                  >
                    Save schedule
                  </ActionButton>
                  {current.schedule ? (
                    <ActionButton
                      busy={clearAction.busy}
                      pendingLabel="Removing…"
                      onClick={clearSchedule}
                      disabled={busy}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      Remove
                    </ActionButton>
                  ) : null}
                </div>
              </form>
            )}
          </>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">
            {project.cadence === "one_off"
              ? "A one-off project runs when you start it from the header."
              : "A standing project runs when you start it or a review comes due."}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-1" data-component="AutonomyControl">
        <span className="text-sm font-medium">Autonomy</span>
        {readOnly ? (
          <p className="text-xs text-[var(--color-muted)]">
            {AUTONOMY_OPTIONS.find((o) => o.value === project.autonomy)?.label ??
              project.autonomy}{" "}
            —{" "}
            {AUTONOMY_OPTIONS.find((o) => o.value === project.autonomy)?.detail}
          </p>
        ) : (
          <>
            <div role="radiogroup" className="flex flex-col gap-1.5">
              {AUTONOMY_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                    autonomy === option.value
                      ? "border-[var(--color-accent)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="autonomy"
                    value={option.value}
                    checked={autonomy === option.value}
                    onChange={() => setAutonomy(option.value)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {option.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {autonomy !== project.autonomy ? (
              <ActionButton
                busy={autonomyAction.busy}
                pendingLabel="Saving…"
                onClick={saveAutonomy}
                disabled={busy}
                className="mt-1 self-start rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                Save autonomy
              </ActionButton>
            ) : null}
          </>
        )}
      </div>

      {invalid ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {invalid}
        </p>
      ) : null}
      <ActionError action={scheduleAction} />
      <ActionError action={clearAction} />
      <ActionError action={autonomyAction} />
      {saved ? (
        <p role="status" className="mt-2 text-sm text-emerald-400">
          {saved}
        </p>
      ) : null}
    </section>
  );
}
