import type { ActivityEntry, ActivityTone } from "@/components/projects/dashboard/activity";
import { initial } from "@/components/projects/dashboard/requirements";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

const DOT: Record<ActivityTone, string> = {
  ok: "bg-emerald-400",
  bad: "bg-red-400",
  now: "bg-[var(--color-accent)]",
  change: "bg-amber-400",
  muted: "bg-[var(--color-muted)]",
};

/** Recent things that happened, as sentences, newest first. */
export function ActivityCard({
  entries,
  onIterations,
}: {
  entries: ActivityEntry[];
  onIterations: () => void;
}) {
  const timeLabel = useTimeLabel();
  return (
    <section
      data-component="DashboardActivity"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        <button
          type="button"
          onClick={onIterations}
          className="ml-auto text-xs text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          Iterations ›
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">Nothing has happened yet.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.key} data-tone={entry.tone} className="flex items-start gap-2 text-sm">
              <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${DOT[entry.tone]}`} />
              <span className="min-w-0 flex-1">
                {entry.text}
                <span className="ml-1 text-xs text-[var(--color-muted)]">· {timeLabel(entry.at, "ago")}</span>
              </span>
              {entry.actor ? (
                <span
                  title={entry.actor}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[10px]"
                >
                  {initial(entry.actor)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
