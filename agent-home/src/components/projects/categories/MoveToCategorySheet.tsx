"use client";

import { Sheet } from "@/components/ui/Sheet";
import { CheckIcon, LoaderIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import type { ProjectCategory, ProjectListItem } from "@/types";

/**
 * "Move to…" for touch screens, where dragging a card is off: every
 * category as a row, the current one marked and disabled. The tapped row
 * spins and every row locks until the move lands.
 */
export function MoveToCategorySheet({
  project,
  categories,
  current,
  pending,
  onPick,
  onClose,
}: {
  project: ProjectListItem;
  categories: ProjectCategory[];
  /** The column the card sits in now (null = Uncategorized). */
  current: string | null;
  /** The category being saved, while a move is in flight. */
  pending: string | null | undefined;
  onPick: (categoryId: string | null) => void;
  onClose: () => void;
}) {
  const t = useT("projects");
  const busy = pending !== undefined;
  const rows: Array<{ id: string | null; name: string; color?: string | null }> = [
    ...categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    { id: null, name: t("uncategorized") },
  ];
  return (
    <Sheet title={t("moveTitle", { name: project.name })} onClose={busy ? () => {} : onClose} component="MoveToCategorySheet">
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const isCurrent = row.id === current;
          const saving = busy && pending === row.id;
          return (
            <li key={row.id ?? "__none"}>
              <button
                type="button"
                data-action="move-to-category"
                data-category={row.id ?? "none"}
                disabled={busy || isCurrent}
                aria-current={isCurrent || undefined}
                aria-busy={saving || undefined}
                onClick={() => onPick(row.id)}
                className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-sm hover:bg-[var(--color-surface-2)] disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-[var(--radius-full)]"
                  style={{ backgroundColor: row.color ?? "var(--color-muted)" }}
                />
                <span className={`min-w-0 flex-1 truncate ${isCurrent ? "text-[var(--color-muted)]" : ""}`}>
                  {row.name}
                </span>
                {saving ? (
                  <LoaderIcon aria-label={t("moving")} className="h-4 w-4 animate-spin text-[var(--color-muted)]" />
                ) : isCurrent ? (
                  <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                    <CheckIcon aria-hidden className="h-3.5 w-3.5" />
                    {t("current")}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-action="move-to-cancel"
        disabled={busy}
        onClick={onClose}
        className="mt-3 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] text-sm disabled:opacity-60"
      >
        {t("cancel")}
      </button>
    </Sheet>
  );
}
