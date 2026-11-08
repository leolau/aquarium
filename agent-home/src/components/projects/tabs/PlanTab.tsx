"use client";

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

export function PlanTab({ project, playbook, canLead }: ProjectTabProps) {
  return (
    <div data-component="PlanTab">
      <PlanPanel
        slug={project.slug}
        playbook={playbook}
        profiles={project.profiles.map((row) => row.profile)}
        hostProfile={project.host_profile}
        canActivate={canLead}
        archived={project.archived}
      />
    </div>
  );
}
