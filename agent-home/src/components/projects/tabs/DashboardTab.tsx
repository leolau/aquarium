"use client";

import { ActivityCard } from "@/components/projects/dashboard/ActivityCard";
import { NeedsYouCard } from "@/components/projects/dashboard/NeedsYouCard";
import { RequirementsCard } from "@/components/projects/dashboard/RequirementsCard";
import { WhereItStands } from "@/components/projects/dashboard/WhereItStands";
import { activityEntries } from "@/components/projects/dashboard/activity";
import { needsYouItems, nextAction } from "@/components/projects/dashboard/nextAction";
import { requirementsSummary } from "@/components/projects/dashboard/requirements";
import { cardsBar, outputsBar, standSteps } from "@/components/projects/dashboard/standProgress";
import { LatestOutputsShelf } from "@/components/projects/outputs/LatestOutputsShelf";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

/** Landing tab: what else needs you, where it stands, latest outputs. The
 * one next action itself lives in the journey bar above every tab; the
 * "Needs you" list points up at it instead of repeating it. */
export function DashboardTab({
  project,
  board,
  playbook,
  directives,
  callerUserId,
  canLead,
  readiness,
  onNavigate,
  onChangeRequest,
}: ProjectTabProps) {
  const hero = nextAction(project, board, readiness, playbook, undefined, canLead);
  const items = needsYouItems({ project, board, readiness, playbook, canLead });
  return (
    <div
      data-component="DashboardTab"
      className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start"
    >
      <div data-column="left" className="flex min-w-0 flex-col gap-4">
        <NeedsYouCard
          slug={project.slug}
          items={items}
          heroKey={hero.key}
          onNavigate={onNavigate}
          onChangeRequest={onChangeRequest}
        />
        <LatestOutputsShelf project={project} onShowAll={() => onNavigate("outputs")} />
      </div>
      <div data-column="right" className="flex min-w-0 flex-col gap-4">
        <WhereItStands
          steps={standSteps(project, board, playbook)}
          outputs={outputsBar(project)}
          cards={cardsBar(board)}
        />
        <RequirementsCard
          summary={requirementsSummary(project, directives)}
          callerUserId={callerUserId}
          onHistory={() => onNavigate("iterations")}
        />
        <ActivityCard
          entries={activityEntries(project, board)}
          onIterations={() => onNavigate("iterations")}
        />
      </div>
    </div>
  );
}
