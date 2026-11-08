import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";
import { ProjectsLoadError } from "@/components/projects/ProjectsLoadError";
import { InfoTip } from "@/components/ui/InfoTip";
import { getT } from "@/i18n/server";
import { ProjectsList } from "@/components/projects/ProjectsList";
import { ProjectsModeView } from "@/components/projects/task/ProjectsModeView";
import {
  projectViewContext,
  type ViewContext,
} from "@/components/projects/task/viewModeServer";
import {
  filtersFromParams,
  filtersToParams,
} from "@/components/projects/filters";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { ProjectsFilterState } from "@/components/projects/filters";
import type { ProjectCategory, ProjectsResponse, ViewDevice } from "@/types";

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
  const principal = await requirePrincipal();
  const raw = await searchParams;
  const client = await apiClientForRequest();
  const view = await projectViewContext(client, raw.view);
  if (view.mode === "task") {
    return <TaskModePage view={view} canStart={principal.role !== "viewer"} />;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "view") continue;
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
    const query = filtersToParams(state);
    const [projectsPage, categoriesRes] = await Promise.all([
      client.projects({
        status: query.get("status") ?? undefined,
        cadence: query.get("cadence") ?? undefined,
        health: query.get("health") ?? undefined,
        archived: query.get("archived") === "true",
        q: state.q || undefined,
        category: query.get("category") ?? undefined,
        sort: query.get("sort") ?? undefined,
        order: query.get("order") ?? undefined,
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

  const t = await getT("projects");
  return (
    <MobileShell
      title="Projects"
      subtitle={t("subtitle")}
      info={<InfoTip label={t("infoLabel")}>{t("info")}</InfoTip>}
      actions={
        <Link
          href="/projects/new"
          data-component="NewProjectAction"
          className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-accent-fg)]"
        >
          {t("newProject")}
        </Link>
      }
      wide
    >
      {error ? (
        <ProjectsLoadError component="ProjectsPageError" details={`Couldn't load your projects (${error}).`} />
      ) : (
        <ProjectsModeView mode="project" device={view.device}>
          <ProjectsList
            initial={projects}
            categories={categories}
            initialFilters={phoneDefaultsToList(state, params, view.device)}
          />
        </ProjectsModeView>
      )}
    </MobileShell>
  );
}

/**
 * Projects in Task mode: every project the caller may read (the list route
 * enforces visibility), of which the home keeps the one-off ones.
 */
async function TaskModePage({ view, canStart }: { view: ViewContext; canStart: boolean }) {
  const client = await apiClientForRequest();
  const [projectsPage, profilesRes] = await Promise.all([
    client
      .projects({ limit: 200 })
      .then((page) => ({ page, error: null as string | null }))
      .catch((err: unknown) => ({
        page: EMPTY_PROJECTS,
        error: err instanceof Error ? err.message : "Failed to load your tasks",
      })),
    canStart ? client.profiles().catch(() => ({ profiles: [] })) : Promise.resolve({ profiles: [] }),
  ]);
  const { error } = projectsPage;
  const items = projectsPage.page.items;
  const profiles = profilesRes.profiles;
  const defaultProfile = profiles.find((p) => p.is_default)?.name ?? profiles[0]?.name ?? "default";
  return (
    <MobileShell title="Projects">
      {error ? (
        <ProjectsLoadError component="ProjectsPageError" details={`Couldn't load your tasks (${error}).`} />
      ) : (
        <ProjectsModeView
          mode="task"
          device={view.device}
          task={{ items, profiles, defaultProfile, canStart }}
        />
      )}
    </MobileShell>
  );
}

/** Phones open the list (Figma "Projects — List — Phone"); the board stays a tap away. */
function phoneDefaultsToList(
  state: ProjectsFilterState,
  params: URLSearchParams,
  device: ViewDevice,
): ProjectsFilterState {
  return device === "phone" && !params.has("layout") ? { ...state, layout: "list" } : state;
}
