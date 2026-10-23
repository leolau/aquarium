import Link from "next/link";

/** "← Back to <project>" at the top of a project's run and card pages. */
export function BackToProject({ slug, name }: { slug: string; name?: string }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(slug)}`}
      data-component="BackToProject"
      className="mb-3 inline-flex max-w-full items-center gap-1 truncate text-sm text-[var(--color-accent)] hover:underline"
    >
      ← Back to {name ? name : "project"}
    </Link>
  );
}

/** "← Projects" at the top of a project's page, back to the projects list. */
export function BackToProjects() {
  return (
    <Link
      href="/projects"
      data-component="BackToProjects"
      className="mb-3 inline-flex max-w-full items-center gap-1 truncate text-sm text-[var(--color-accent)] hover:underline"
    >
      ← Projects
    </Link>
  );
}
