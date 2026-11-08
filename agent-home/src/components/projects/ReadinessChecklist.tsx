import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectTab } from "@/components/projects/tabs/types";

/**
 * The header's answer to "why can't I run this?" — every precondition the
 * run gate checks, numbered in the order a person would clear them, each
 * with either a link to the tab that fixes it (switched in place via
 * `onNavigate` when given, else a plain `?tab=` link) or (for "status") a
 * one-click Activate button right here — no need to go find where that
 * button lives. Hidden once the project is runnable so a healthy project
 * keeps a quiet header.
 */
export function ReadinessChecklist({
  items,
  findings,
  onActivate,
  activating = false,
  onNavigate,
  onItem,
}: {
  items: ReadinessItem[];
  findings: { code: string; severity: string; text: string }[];
  /** Wired up for the "status" item so Activate is a click, not a hunt. */
  onActivate?: () => void;
  activating?: boolean;
  /** Switch tab in place instead of following the `?tab=` href. */
  onNavigate?: (tab: ProjectTab) => void;
  /** Open the item's tab and reveal its field (wins over `onNavigate`). */
  onItem?: (item: ReadinessItem) => void;
}) {
  const missing = items.filter((item) => !item.ok);
  if (missing.length === 0 && findings.length === 0) return null;
  const stepFor = new Map(missing.map((item, i) => [item.key, i + 1]));
  return (
    <div
      data-component="ReadinessChecklist"
      className="mt-3 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
    >
      {missing.length > 0 ? (
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
          Before it can run — in order
        </p>
      ) : null}
      <ol className="mt-1 flex flex-col gap-1.5">
        {items.map((item) => {
          return (
            <li key={item.key} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className={
                  item.ok
                    ? "text-emerald-400"
                    : "text-[var(--color-warn-text)] tabular-nums"
                }
              >
                {item.ok ? "✓" : `${stepFor.get(item.key) ?? 0}.`}
              </span>
              <span className="min-w-0 flex-1">
                <span className={item.ok ? "text-[var(--color-muted)]" : ""}>
                  {item.label}
                </span>
                {!item.ok ? (
                  <>
                    {" — "}
                    {item.key === "status" && onActivate ? (
                      <button
                        type="button"
                        onClick={onActivate}
                        disabled={activating}
                        className="text-[var(--color-accent)] underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {activating ? "Activating…" : "Activate now"}
                      </button>
                    ) : (
                      <a
                        href={item.anchor}
                        onClick={
                          onItem
                            ? (event) => {
                                event.preventDefault();
                                onItem(item);
                              }
                            : onNavigate && item.tab
                              ? (event) => {
                                  event.preventDefault();
                                  onNavigate(item.tab as ProjectTab);
                                }
                              : undefined
                        }
                        className="text-[var(--color-accent)] underline-offset-2 hover:underline"
                      >
                        {item.hint}
                      </a>
                    )}
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
        {findings.map((finding) => (
          <li
            key={finding.code}
            className="flex items-start gap-2 text-sm"
            data-severity={finding.severity}
          >
            <span
              aria-hidden
              className={
                finding.severity === "stalled" ? "text-[var(--color-danger)]" : "text-[var(--color-warn-text)]"
              }
            >
              !
            </span>
            <span className="min-w-0 flex-1">{finding.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
