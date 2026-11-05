import { initial, personLabel } from "@/components/projects/dashboard/requirements";
import type { RequirementsSummary } from "@/components/projects/dashboard/requirements";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/** The brief's key points plus active directives; the newest change stands out. */
export function RequirementsCard({
  summary,
  callerUserId,
  onHistory,
}: {
  summary: RequirementsSummary;
  callerUserId: string;
  onHistory: () => void;
}) {
  const timeLabel = useTimeLabel();
  return (
    <section
      data-component="CurrentRequirements"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Current requirements</h2>
        <span
          data-component="RequirementsVersion"
          className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-muted)]"
        >
          v{summary.version}
        </span>
        <button
          type="button"
          onClick={onHistory}
          className="ml-auto text-xs text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          History ›
        </button>
      </div>
      {summary.lines.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">No brief yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {summary.lines.map((line) => {
            const who = line.author ? personLabel(line.author, callerUserId) : null;
            return (
              <li
                key={line.key}
                data-new={line.isNew ? "true" : undefined}
                className={`text-sm ${
                  line.isNew
                    ? "rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
                    : ""
                }`}
              >
                <span className="flex gap-2">
                  <span aria-hidden className="text-[var(--color-muted)]">•</span>
                  <span className="min-w-0 flex-1">{line.text}</span>
                </span>
                {line.isNew ? (
                  <span className="mt-1 flex items-center gap-1.5 pl-4 text-xs text-[var(--color-muted)]">
                    <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-medium uppercase text-[var(--color-warn-text)]">
                      new
                    </span>
                    {who ? (
                      <>
                        <span
                          aria-hidden
                          className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[10px]"
                        >
                          {initial(who)}
                        </span>
                        <span>{who}</span>
                      </>
                    ) : null}
                    {line.at != null ? <span>· {timeLabel(line.at)}</span> : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
