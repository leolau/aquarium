import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { ProjectsLoadError } from "@/components/projects/ProjectsLoadError";
import { isTaskCadence } from "@/components/projects/task/viewMode";
import { ProjectViewSwitch } from "@/components/projects/task/ProjectViewSwitch";
import { projectViewContext } from "@/components/projects/task/viewModeServer";
import { ProjectDetailView } from "@/components/projects/ProjectDetailView";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type {
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectPlaybookResponse,
} from "@/types";

// Reads the live principal + the project record per request — never at build
// time.
export const dynamic = "force-dynamic";

/**
 * **The one place** (§13): everything a project knows, on one page.
 *
 * The detail read is the only mandatory fetch; the board, playbook and
 * directives are fan-out reads (§16) — each in its own try/catch so a dead
 * profile only blanks its own panel, never the page.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ tab?: string | string[]; view?: string | string[] }>;
}) {
  const principal = await requirePrincipal();
  const { slug } = await params;
  const query = await searchParams;
  const rawTab = query?.tab;
  const initialTab = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  const client = await apiClientForRequest();

  // Fetch under the try, render outside it — JSX built inside a try/catch
  // never reaches the catch (the render happens later).
  let project: ProjectDetail | null = null;
  try {
    project = await client.project(slug);
  } catch (err) {
    // A 404 is the API's deliberate answer for a missing *or unreadable*
    // project (§11) — render Next's own not-found, not a load error (F7).
    if (err instanceof HermesApiError && err.status === 404) notFound();
  }

  if (!project) {
    return (
      <MobileShell title="Project">
        <ProjectsLoadError component="ProjectPageError" details={"Couldn't load this project right now."} />
      </MobileShell>
    );
  }

  const [board, playbook, directives, doctor, view] = await Promise.all([
    client.projectBoard(slug).catch((): ProjectBoardView | null => null),
    client.projectPlaybook(slug).catch(
      (): ProjectPlaybookResponse | null => null,
    ),
    client.projectDirectives(slug).catch(
      (): ProjectDirectivesResponse | null => null,
    ),
    client.projectDoctor(slug).catch((): ProjectDoctorDetail | null => null),
    // A tab link means Project mode: tabs only exist there.
    // A one-off opens as its Task view unless the URL asks for the project.
    projectViewContext(
      client,
      initialTab ? "project" : query?.view ?? (isTaskCadence(project.cadence) ? "task" : undefined),
    ),
  ]);
  const isInstanceAdmin = principal.role === "owner" || principal.role === "admin";

  return (
    <MobileShell title={project.name} wide>
      <ProjectViewSwitch
        initialMode={view.mode}
        device={view.device}
        task={{
          project,
          board,
          playbook,
          directives,
          callerUserId: principal.user_id,
          isInstanceAdmin,
        }}
      >
        <ProjectDetailView
          project={project}
          board={board}
          playbook={playbook}
          directives={directives}
          doctor={doctor}
          callerUserId={principal.user_id}
          isInstanceAdmin={isInstanceAdmin}
          initialTab={initialTab}
        />
      </ProjectViewSwitch>
    </MobileShell>
  );
}
