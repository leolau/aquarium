"use client";

import { useState } from "react";

import { CreateSkillSheet, ImproveSkillSheet } from "@/components/projects/skills/AiSheets";
import type { ProjectSkill } from "@/components/projects/skills/model";
import { ProjectSkillsPanel } from "@/components/projects/skills/ProjectSkillsPanel";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

export function SkillsTab({ project, onNavigate }: ProjectTabProps) {
  const [improving, setImproving] = useState<ProjectSkill | null>(null);
  const [creating, setCreating] = useState<{ candidateId?: string } | null>(null);
  const hostProfile = project.host_profile || "default";
  return (
    <div data-component="SkillsTab">
      <ProjectSkillsPanel
        slug={project.slug}
        hostProfile={hostProfile}
        archived={project.archived}
        onOpenSetup={() => onNavigate("settings")}
        onImprove={setImproving}
        onCreate={setCreating}
      />
      {improving ? (
        <ImproveSkillSheet slug={project.slug} skill={improving} onClose={() => setImproving(null)} />
      ) : null}
      {creating ? (
        <CreateSkillSheet
          slug={project.slug}
          profile={hostProfile}
          candidateId={creating.candidateId}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}
