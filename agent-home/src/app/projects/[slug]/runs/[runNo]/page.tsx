import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { BackToProject } from "@/components/projects/BackToProject";
import { RunView } from "@/components/projects/RunView";
import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { ProjectRun } from "@/types";

// Reads the live principal + the run row per request — never at build time.
export const dynamic = "force-dynamic";

/**
 * **One run's page** (§7): the cards it moved, what it delivered, its cost
 * and its retro — the record a score gets pinned to (score-it lands in 9b).
 */
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string; runNo: string }>;
}) {
  await requirePrincipal();
  const { slug, runNo } = await params;
  const runNoInt = Number(runNo);

  if (!Number.isInteger(runNoInt) || runNoInt < 1) {
    return (
      <MobileShell title="Run">
        <div
          data-component="RunPageError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          That run number doesn&apos;t look right.
        </div>
      </MobileShell>
    );
  }

  const client = await apiClientForRequest();
  // Fetch under the try, render outside it. The run is the page; the
  // project read only carries the `archived` flag for RunView and the
  // back link's name — if it fails the page renders unflagged, and the
  // router refuses the writes anyway.
  let run: ProjectRun | null = null;
  let project: { archived: boolean; name?: string } = { archived: false };
  try {
    [run, project] = await Promise.all([
      client.projectRun(slug, runNoInt),
      client
        .project(slug)
        .then((p) => ({ archived: Boolean(p.archived), name: p.name }))
        .catch(() => ({ archived: false })),
    ]);
  } catch (err) {
    // 404 = no such run (or no such project for this caller) — Next's
    // not-found, not a load error that prints upstream detail (F7).
    if (err instanceof HermesApiError && err.status === 404) notFound();
  }

  if (!run) {
    return (
      <MobileShell title="Run">
        <BackToProject slug={slug} name={project.name} />
        <div
          data-component="RunPageError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load run {runNoInt} right now.
        </div>
      </MobileShell>
    );
  }

  return (
    <MobileShell title={`Run ${runNoInt}`}>
      <BackToProject slug={slug} name={project.name} />
      <RunView slug={slug} run={run} archived={project.archived} />
    </MobileShell>
  );
}
