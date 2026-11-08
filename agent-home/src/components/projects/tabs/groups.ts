import type { ProjectTab } from "@/components/projects/tabs/types";

/**
 * The project page's four tabs (Figma "Inner — Projects"). Each groups some
 * of the eight older sections, which stay addressable: `?tab=settings` opens
 * Setup scrolled to its Settings section.
 */
export const PROJECT_GROUPS = ["overview", "work", "files", "setup"] as const;

export type ProjectGroup = (typeof PROJECT_GROUPS)[number];

export const PROJECT_GROUP_LABEL: Record<ProjectGroup, string> = {
  overview: "Overview",
  work: "Work",
  files: "Files",
  setup: "Setup",
};

/** The sections each tab shows, top to bottom. */
export const GROUP_SECTIONS: Record<ProjectGroup, readonly ProjectTab[]> = {
  overview: ["dashboard"],
  work: ["board", "iterations"],
  files: ["outputs", "inputs"],
  setup: ["scope", "plan", "settings"],
};

export function groupOf(tab: ProjectTab): ProjectGroup {
  for (const group of PROJECT_GROUPS) {
    if (GROUP_SECTIONS[group].includes(tab)) return group;
  }
  return "overview";
}

export function isProjectGroup(value: string | null | undefined): value is ProjectGroup {
  return (PROJECT_GROUPS as readonly string[]).includes(value ?? "");
}
