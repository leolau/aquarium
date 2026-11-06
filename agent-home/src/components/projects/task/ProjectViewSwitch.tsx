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
      <div className="flex items-center justify-end gap-2">
        {!eligible ? <span className="text-xs text-[var(--color-muted)]">{NOT_A_TASK}</span> : null}
        <ModeSwitch mode={mode} onChange={change} taskDisabledReason={eligible ? undefined : NOT_A_TASK} />
      </div>
      {mode === "task" ? <TaskView {...task} onOpenProject={() => change("project")} /> : children}
    </div>
  );
}
