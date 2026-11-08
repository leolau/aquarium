import { LogoutButton } from "@/components/LogoutButton";
import { MobileShell } from "@/components/MobileShell";
import { LandingComposer } from "@/components/landing/LandingComposer";
import { LandingLayout } from "@/components/landing/LandingLayout";
import { ProjectsHomeCard } from "@/components/projects/ProjectsHomeCard";
import { ActivityStrip } from "@/components/ui/ActivityStrip";
import { StatusStrip } from "@/components/ui/StatusStrip";
import { activeEnrolments } from "@/lib/api/my-profiles";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import type { ProfileSummary, ProjectCategory, ProjectListItem } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The landing page (docs/design/landing-redesign): top bar, chats sidebar,
 * the centre composer, and the needs-you / background-work panel. Every read
 * is best-effort so one failing upstream never blanks the page.
 */
export default async function HomePage() {
  await requirePrincipal();
  const currentProfile = (await readSession())?.profile ?? "default";

  let profiles: ProfileSummary[] = [];
  let activeProjects: ProjectListItem[] | null = null;
  let projectCategories: ProjectCategory[] = [];
  try {
    const client = await apiClientForRequest();
    const [mine, projects, categories] = await Promise.all([
      client.myProfiles().catch(() => null),
      client.projects({ status: "active", limit: 5 }).catch(() => null),
      client.projectCategories().catch(() => ({ items: [] })),
    ]);
    profiles = mine ? activeEnrolments(mine) : [];
    activeProjects = projects?.items ?? null;
    projectCategories = categories.items ?? [];
  } catch {
    // The composer still works without profiles or projects.
  }

  return (
    <MobileShell title="Aquarium" bare>
      <LandingLayout
        topBar={
          <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 backdrop-blur">
            <StatusStrip />
            <ActivityStrip />
          </div>
        }
        main={<LandingComposer profiles={profiles} currentProfile={currentProfile} />}
        aside={
          <div className="flex flex-col gap-4">
            {activeProjects ? (
              <ProjectsHomeCard items={activeProjects} categories={projectCategories} />
            ) : null}
            <LogoutButton />
          </div>
        }
      />
    </MobileShell>
  );
}
