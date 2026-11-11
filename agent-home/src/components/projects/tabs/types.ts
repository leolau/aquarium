import type { ReadinessItem } from "@/components/projects/readiness";
import type {
  ProjectBoardView,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectPlaybookResponse,
} from "@/types";

/** The project page's tabs, in order. The Dashboard is the landing tab. */
export const PROJECT_TABS = [
  "dashboard",
  "scope",
  "board",
  "outputs",
  "iterations",
  "inputs",
  "skills",
  "plan",
  "settings",
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export const PROJECT_TAB_LABEL: Record<ProjectTab, string> = {
  dashboard: "Dashboard",
  scope: "Scope",
  board: "Board",
  outputs: "Outputs",
  iterations: "Iterations",
  inputs: "Inputs",
  skills: "Skills",
  plan: "Plan",
  settings: "Settings",
};

export function parseProjectTab(value: string | null | undefined): ProjectTab {
  return (PROJECT_TABS as readonly string[]).includes(value ?? "")
    ? (value as ProjectTab)
    : "dashboard";
}

/** Everything a tab may read. Every tab gets the same props. */
export interface ProjectTabProps {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  playbook: ProjectPlaybookResponse | null;
  directives: ProjectDirectivesResponse | null;
  doctor: ProjectDoctorDetail | null;
  callerUserId: string;
  /** Owner, lead or box admin. */
  canLead: boolean;
  readiness: ReadinessItem[];
  runnable: boolean;
  /** Switch tab (and update `?tab=`). */
  onNavigate: (tab: ProjectTab) => void;
  /** Open the "What's changed?" flow, optionally pre-filled. */
  onChangeRequest: (initialText?: string) => void;
}
