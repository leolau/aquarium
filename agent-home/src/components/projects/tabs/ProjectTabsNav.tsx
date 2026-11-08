"use client";

import { PROJECT_GROUPS, type ProjectGroup } from "@/components/projects/tabs/groups";
import { useT } from "@/i18n";

/**
 * Figma `segmented-tabs` (16:92): Overview · Work · Files · Setup. Scrolls
 * sideways inside itself (never the page) if a translation runs long.
 */
export function ProjectTabsNav({
  active,
  onSelect,
  badges = {},
}: {
  active: ProjectGroup;
  onSelect: (group: ProjectGroup) => void;
  /** e.g. `{ work: 3 }` — how many things on that tab need a person. */
  badges?: Partial<Record<ProjectGroup, number>>;
}) {
  const t = useT("projects");
  return (
    <nav data-component="ProjectTabsNav" aria-label={t("tabs.aria")} className="min-w-0 max-w-full overflow-x-auto">
      <ul
        role="tablist"
        className="flex w-max gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
      >
        {PROJECT_GROUPS.map((group) => {
          const on = group === active;
          const badge = badges[group] ?? 0;
          return (
            <li key={group}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                data-tab={group}
                onClick={() => onSelect(group)}
                className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-md)] px-3 text-sm ${
                  on
                    ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                }`}
              >
                {t(`tabs.${group}`)}
                {badge > 0 ? (
                  <span className="rounded-[var(--radius-full)] bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold text-[var(--color-accent-fg)]">
                    {badge}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
