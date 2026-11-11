"use client";

import { useMemo, useState } from "react";

import { CreateSkillSheet, MAX_CREATE_CARDS, doneCards } from "@/components/projects/skills/CreateSkillSheet";
import { ImproveSkillSheet } from "@/components/projects/skills/ImproveSkillSheet";
import type { ProjectSkill } from "@/components/projects/skills/model";
import { ProjectSkillsPanel } from "@/components/projects/skills/ProjectSkillsPanel";
import { useProjectSkills } from "@/components/projects/skills/store";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

export function SkillsTab({ project, board, canLead, onNavigate }: ProjectTabProps) {
  const [improving, setImproving] = useState<ProjectSkill | null>(null);
  const [creating, setCreating] = useState<{ candidateId?: string } | null>(null);
  const hostProfile = project.host_profile || "default";
  // Same window the panel opens on, so this reads its cached response.
  const { state, reload } = useProjectSkills(project.slug, 90);
  const candidate = useMemo(() => {
    const id = creating?.candidateId;
    const c = id && state.status === "ready" ? state.view.candidates.find((x) => x.id === id) : undefined;
    return c ? { id: c.id, name: c.name, body: c.preview } : id ? { id, name: id } : null;
  }, [creating, state]);
  const cards = useMemo(() => (board ? doneCards(board).slice(0, MAX_CREATE_CARDS) : undefined), [board]);
  return (
    <div data-component="SkillsTab">
      <ProjectSkillsPanel
        slug={project.slug}
        projectName={project.name}
        hostProfile={hostProfile}
        archived={project.archived}
        onOpenSetup={() => onNavigate("settings")}
        onImprove={setImproving}
        onCreate={setCreating}
      />
      {improving ? (
        <ImproveSkillSheet
          project={{ slug: project.slug, name: project.name }}
          skill={{ name: improving.name, profile: improving.profile }}
          onClose={() => setImproving(null)}
        />
      ) : null}
      {creating ? (
        <CreateSkillSheet
          slug={project.slug}
          projectName={project.name}
          profile={hostProfile}
          candidate={candidate}
          cards={cards}
          canPreload={canLead && !project.archived}
          preloaded={(project.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean)}
          onClose={() => setCreating(null)}
          onCreated={() => void reload()}
        />
      ) : null}
    </div>
  );
}
