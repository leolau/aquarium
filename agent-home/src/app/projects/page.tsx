import { MobileShell } from "@/components/MobileShell";
import { ProjectsList } from "@/components/projects/ProjectsList";
import {
  filtersFromParams,
  filtersToParams,
} from "@/components/projects/filters";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { ProjectCategory, ProjectsResponse } from "@/types";

// Reads the live principal (cookie) + the caller's readable projects per
// request — never at build time.
export const dynamic = "force-dynamic";

const EMPTY_PROJECTS: ProjectsResponse = { items: [], next_cursor: null };

/**
 * **Projects** — everything the agent works on over time (§13).
 *
 * BFF: the server resolves the principal and loads the first page from the
 * same filters the URL carries, so a shared `/projects?cadence=standing`
 * link arrives already filtered. The list defaults to the live work —
 * `filtersFromParams` maps an empty querystring onto `status=active`.
 * The categories (the board's columns) load alongside; failing to read them
 * only degrades the board to its Uncategorized column.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePrincipal();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      params.set(key, Array.isArray(value) ? value[0] : value);
    }
  }

  let projects: ProjectsResponse = EMPTY_PROJECTS;
  let categories: ProjectCategory[] = [];
  let error: string | null = null;
  // The codec is authoritative: the URL narrows by status/cadence/health,
  // and the same round-trip drives the client-side refetch. `layout` is a
  // view preference and never reaches the upstream query.
  const state = filtersFromParams(params);
  try {
    const client = await apiClientForRequest();
    const query = filtersToParams(state);
    const [projectsPage, categoriesRes] = await Promise.all([
      client.projects({
        status: query.get("status") ?? undefined,
        cadence: query.get("cadence") ?? undefined,
        health: query.get("health") ?? undefined,
        archived: query.get("archived") === "true",
        q: state.q || undefined,
        category: query.get("category") ?? undefined,
        // Both layouts read every page; start with the largest one.
        limit: 200,
      }),
      client.projectCategories().catch(() => ({ items: [] })),
    ]);
    projects = projectsPage;
    categories = categoriesRes.items ?? [];
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load your projects";
  }

  return (
    <MobileShell title="Projects">
      {error ? (
        <div
          data-component="ProjectsPageError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load your projects ({error}).
        </div>
      ) : (
        <ProjectsList
          initial={projects}
          categories={categories}
          initialFilters={state}
        />
      )}
    </MobileShell>
  );
}
