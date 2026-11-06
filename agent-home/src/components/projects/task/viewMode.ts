import type {
  ProjectAutonomy,
  ProjectCadence,
  ProjectListItem,
  ProjectViewMode,
  ViewDevice,
} from "@/types";

export const PROJECT_VIEW_MODES: readonly ProjectViewMode[] = ["task", "project"];
export const VIEW_DEVICES: readonly ViewDevice[] = ["desktop", "phone"];

export type SavedViewModes = Partial<Record<ViewDevice, ProjectViewMode>>;

export function isProjectViewMode(value: unknown): value is ProjectViewMode {
  return typeof value === "string" && (PROJECT_VIEW_MODES as readonly string[]).includes(value);
}

export function isViewDevice(value: unknown): value is ViewDevice {
  return typeof value === "string" && (VIEW_DEVICES as readonly string[]).includes(value);
}

const PHONE_UA = /Mobi|Android.+Mobile|iPhone|iPod|Windows Phone/i;

/**
 * The device class a request comes from, decided on the server so the first
 * render already shows the right mode (no hydration flip). `Sec-CH-UA-Mobile`
 * wins when the browser sends it; otherwise the user agent.
 */
export function deviceFromHeaders(
  userAgent: string | null | undefined,
  chUaMobile?: string | null,
): ViewDevice {
  if (chUaMobile === "?1") return "phone";
  if (chUaMobile === "?0") return "desktop";
  return PHONE_UA.test(userAgent ?? "") ? "phone" : "desktop";
}

/** The saved choice for this device class, else Task on phones, Project on desktop. */
export function resolveViewMode(saved: SavedViewModes | null | undefined, device: ViewDevice): ProjectViewMode {
  const chosen = saved?.[device];
  if (isProjectViewMode(chosen)) return chosen;
  return device === "phone" ? "task" : "project";
}

/** Only one-off projects are tasks; repeating and standing ones stay in Project mode. */
export function isTaskCadence(cadence: ProjectCadence): boolean {
  return cadence === "one_off";
}

export interface CheckInChoice {
  autonomy: ProjectAutonomy;
  label: string;
}

/** Task mode's "Check in with me" picker, as the autonomy it sets. */
export const CHECK_IN_CHOICES: readonly CheckInChoice[] = [
  { autonomy: "supervised", label: "Before risky steps" },
  { autonomy: "autonomous", label: "Only at the end" },
  { autonomy: "manual", label: "Every step" },
];

export const DEFAULT_CHECK_IN: ProjectAutonomy = "supervised";

export function checkInLabel(autonomy: ProjectAutonomy): string {
  return CHECK_IN_CHOICES.find((c) => c.autonomy === autonomy)?.label ?? autonomy;
}

export type TaskBucket = "needs_you" | "running" | "done" | "failed";

/**
 * Which Task-mode list a one-off project belongs in, from the list row the
 * server already returns (no extra reads).
 */
export function taskBucket(item: ProjectListItem): TaskBucket {
  const run = item.latest_run?.status;
  if (run === "failed" || run === "cancelled") {
    return item.status === "done" ? "done" : "failed";
  }
  if (item.status === "done") return "done";
  if (
    item.plan_pending === true ||
    run === "waiting" ||
    run === "blocked" ||
    item.health !== "ok" ||
    item.status === "needs_completion" ||
    (item.output_rollup?.awaiting_acceptance ?? 0) > 0
  ) {
    return "needs_you";
  }
  return "running";
}

export interface TaskLists {
  needsYou: ProjectListItem[];
  running: ProjectListItem[];
  done: ProjectListItem[];
  /** Repeating and standing projects the caller can see, left to Project mode. */
  hiddenCount: number;
}

/** Split the caller's projects into Task mode's lists; failed tasks sit in Needs you. */
export function taskLists(items: ProjectListItem[]): TaskLists {
  const lists: TaskLists = { needsYou: [], running: [], done: [], hiddenCount: 0 };
  for (const item of items) {
    if (item.archived) continue;
    if (!isTaskCadence(item.cadence)) {
      lists.hiddenCount += 1;
      continue;
    }
    const bucket = taskBucket(item);
    if (bucket === "done") lists.done.push(item);
    else if (bucket === "running") lists.running.push(item);
    else lists.needsYou.push(item);
  }
  return lists;
}

export function projectHref(slug: string, mode?: ProjectViewMode): string {
  const base = `/projects/${encodeURIComponent(slug)}`;
  return mode === "project" ? `${base}?view=project` : base;
}
