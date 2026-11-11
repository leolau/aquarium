"use client";

import { BriefPanel } from "@/components/projects/panels/BriefPanel";
import { PeoplePanel } from "@/components/projects/panels/PeoplePanel";
import { SettingsPanel } from "@/components/projects/panels/SettingsPanel";
import { ToolsPanel } from "@/components/projects/panels/ToolsPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

export function SettingsTab({ project, playbook, canLead, onNavigate }: ProjectTabProps) {
  return (
    <div data-component="SettingsTab" className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start">
      <BriefPanel project={project} />
      <SettingsPanel project={project} canLead={canLead} hasActivePlan={Boolean(playbook?.active)} />
      <PeoplePanel project={project} archived={project.archived} />
      <ToolsPanel project={project} archived={project.archived} onOpenSkills={() => onNavigate("skills")} />
    </div>
  );
}
