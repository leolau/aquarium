import { changeKindLabel } from "@/components/projects/changes/kinds";
import type { Requirement } from "@/components/projects/iterations/groupIterations";
import { Pill } from "@/components/ui/Pill";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/** Every requirement change, newest first: who, when, what kind, and where it first applied. */
export function RequirementHistory({ requirements }: { requirements: Requirement[] }) {
  const timeLabel = useTimeLabel();
  return (
    <section
      data-component="RequirementHistory"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-sm font-semibold">Requirement history</h2>
      {requirements.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No requirement changes yet. Use “Start a new iteration with changes” to add one.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {requirements.map((r) => (
            <li
              key={r.id}
              data-requirement={r.id}
              data-status={r.status}
              className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-2 text-sm last:border-b-0"
            >
              <span className={r.status === "retired" ? "text-[var(--color-muted)] line-through" : ""}>
                {r.body}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
                <Pill tone={r.status === "active" ? "success" : "muted"}>{r.status}</Pill>
                {r.kinds.map((k) => (
                  <Pill key={k}>{changeKindLabel(k)}</Pill>
                ))}
                <span>
                  {r.author} · {timeLabel(r.createdAt)}
                </span>
                <span>
                  ·{" "}
                  {r.firstIteration != null
                    ? `from iteration ${r.firstIteration}`
                    : "not applied yet"}
                </span>
                {r.status === "retired" && r.supersededBy ? <span>· superseded</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
