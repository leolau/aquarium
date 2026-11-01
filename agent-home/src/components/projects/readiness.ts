import type { ProjectTab } from "@/components/projects/tabs/types";
import type {
  ProjectDetail,
  ProjectDoctorDetail,
  ProjectPlaybookResponse,
} from "@/types";

export interface ReadinessItem {
  key: "outputs" | "profile" | "plan" | "schedule" | "status";
  label: string;
  ok: boolean;
  /** What to do when not ok — one short sentence. */
  hint: string;
  /** Where the fix lives: a `?tab=` link (or the header for "status"). */
  anchor: string;
  /** The tab that fixes it — set for every item except "status", whose fix
   * is the journey bar's Activate button. */
  tab?: ProjectTab;
  /** Element id of the field that fixes it, for the journey bar to reveal. */
  target?: string;
}

/**
 * What the run gate (`start_run`) will refuse on, computed from data the
 * page already holds so the header can say it *before* the click instead of
 * surfacing a 409 string after it. Doctor findings ride beside these for
 * anything only the server can see (a detached cron job, an overdue run).
 */
export function readinessItems(
  project: ProjectDetail,
  playbook: ProjectPlaybookResponse | null,
): ReadinessItem[] {
  const activePlan = playbook?.active ?? null;
  const hasSteps = (activePlan?.steps ?? []).length > 0;
  const items: ReadinessItem[] = [
    {
      key: "outputs",
      label: "At least one output",
      ok: project.outputs.length > 0,
      hint: "Declare what the project delivers.",
      anchor: "?tab=outputs",
      tab: "outputs",
      target: "add-output",
    },
    {
      key: "profile",
      label: "A profile to run on",
      ok: project.profiles.length > 0,
      hint: "Add the host profile under Settings → People.",
      anchor: "?tab=settings",
      tab: "settings",
      target: "panel-people",
    },
    {
      key: "plan",
      label: "An active plan with steps",
      ok: activePlan != null && hasSteps,
      hint:
        activePlan == null
          ? playbook == null
            ? "The plan could not be loaded."
            : (playbook.revisions ?? []).length > 0
              ? "A revision is waiting — activate it."
              : "Write a plan or ask the agent to draft one."
          : "The active plan has no steps.",
      anchor: "?tab=plan",
      tab: "plan",
      target: "panel-plan",
    },
    // The activation gate itself (`PATCH status=active`) refuses on the
    // same outputs/profile prerequisites, so it belongs right after them —
    // not lumped in with "runnable" as a separate, differently-worded check
    // the way `ProgressPanel.nextAction` used to do it.
    {
      key: "status",
      label: "Project activated",
      ok: project.status === "active",
      hint: "Activate it — the button is in the journey bar at the top.",
      anchor: "#journey-bar",
      target: "journey-primary",
    },
  ];
  if (project.cadence === "repeatable") {
    items.push({
      key: "schedule",
      label: "A schedule",
      ok: Boolean(project.schedule),
      hint: "Repeatable projects need a schedule to fire.",
      anchor: "?tab=settings",
      tab: "settings",
      target: "panel-settings",
    });
  }
  return items;
}

/** Doctor findings the local checklist does not already cover. */
export function extraFindings(
  doctor: ProjectDoctorDetail | null,
  items: ReadinessItem[],
): { code: string; severity: string; text: string }[] {
  if (!doctor) return [];
  const covered = new Set<string>();
  for (const item of items) {
    if (item.key === "plan") covered.add("no_active_playbook");
    if (item.key === "schedule") covered.add("no_schedule");
    if (item.key === "profile") covered.add("host_profile_missing");
  }
  return doctor.findings
    .filter((f) => !covered.has(f.code))
    .map((f) => ({
      code: f.code,
      severity: f.severity,
      text: f.detail ?? f.message ?? f.code,
    }));
}

export function isRunnable(items: ReadinessItem[]): boolean {
  return items.every((item) => item.ok);
}
