"use client";

import { useState, type ReactNode } from "react";

import type { ProjectViewMode, ViewDevice } from "@/types";

import { ModeSwitch } from "./ModeSwitch";
import { saveViewMode } from "./saveViewMode";
import { TaskView } from "./TaskView";
import { isTaskCadence } from "./viewMode";

type TaskViewData = Omit<Parameters<typeof TaskView>[0], "onOpenProject">;

export const NOT_A_TASK =
  "Repeating and standing projects stay in Project mode.";

/**
 * One project page, two views: the switch flips between Task mode and
 * Project mode in place (same data, no reload) and remembers the choice for
 * this device class. A repeating or standing project always shows Project mode.
 */
export function ProjectViewSwitch({
  initialMode,
  device,
  task,
  children,
}: {
  initialMode: ProjectViewMode;
  device: ViewDevice;
  task: TaskViewData;
  /** Project mode: today's project page, unchanged. */
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<ProjectViewMode>(initialMode);
  const eligible = isTaskCadence(task.project.cadence);
  const mode: ProjectViewMode = eligible ? chosen : "project";
  const change = (next: ProjectViewMode) => {
    setChosen(next);
    saveViewMode(device, next);
  };
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
