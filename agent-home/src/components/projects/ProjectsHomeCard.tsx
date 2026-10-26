import Link from "next/link";

import { ProjectRow } from "@/components/projects/ProjectRow";
import type { ProjectCategory, ProjectListItem } from "@/types";

/**
 * The first-class Home card (§13): the active projects, one tap from Home,
 * as the same project cards the `/projects` list shows. The fetch stays in
 * the page — this is the pure render, so it can be tested without a
 * principal and the card degrades where the data does.
 */
export function ProjectsHomeCard({
  items,
  categories = [],
}: {
  items: ProjectListItem[];
  categories?: readonly ProjectCategory[];
}) {
  return (
    <section
      data-component="ProjectsHomeCard"
      className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Projects
        </p>
        <Link
          href="/projects"
          data-component="ProjectsHomeAll"
          className="text-xs text-[var(--color-accent)]"
        >
          All projects ›
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Nothing running right now. When the agent takes on work that lasts —
          a deliverable, a recurring job, a standing duty — it shows up here.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((project) => (
            <ProjectRow key={project.id} project={project} categories={categories} />
          ))}
        </ul>
      )}
    </section>
  );
}
