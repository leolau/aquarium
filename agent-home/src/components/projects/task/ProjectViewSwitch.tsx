"use client";

import { useState, type ReactNode } from "react";

import type { ProjectViewMode } from "@/types";

import { ModeSwitch } from "./ModeSwitch";
import { TaskView } from "./TaskView";
import { isTaskCadence } from "./viewMode";

type TaskViewData = Omit<Parameters<typeof TaskView>[0], "onOpenProject">;

export const NOT_A_TASK =
  "Repeating and standing projects stay in Project mode.";

/**
 * One project page, two views: the switch flips between Task mode and
 * Project mode in place (same data, no reload). A one-off always opens as
 * its Task view, so the flip is not saved: saving it would turn the
 * Projects list into Task mode on this device. A repeating or standing
 * project always shows Project mode.
 */
export function ProjectViewSwitch({
  initialMode,
  task,
  children,
}: {
  initialMode: ProjectViewMode;
  task: TaskViewData;
  /** Project mode: today's project page, unchanged. */
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<ProjectViewMode>(initialMode);
  const eligible = isTaskCadence(task.project.cadence);
  const mode: ProjectViewMode = eligible ? chosen : "project";
  const change = (next: ProjectViewMode) => setChosen(next);
  return (
    <div data-component="ProjectViewSwitch" data-mode={mode} className="flex flex-col gap-3">
      {/* Only a one-off has a Task view; it opens there, and "Open full project"
          (in the Task view) leads here — the switch is then the way back. */}
      {eligible && mode === "project" ? (
        <div className="flex items-center justify-end gap-2">
          <ModeSwitch mode={mode} onChange={change} />
        </div>
      ) : null}
      {mode === "task" ? <TaskView {...task} onOpenProject={() => setChosen("project")} /> : children}
    </div>
  );
}
