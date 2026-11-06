"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";

import type { ProjectViewMode, ViewDevice } from "@/types";

import { ModeSwitch } from "./ModeSwitch";
import { saveViewMode } from "./saveViewMode";
import { TaskHome } from "./TaskHome";

type TaskHomeData = Omit<Parameters<typeof TaskHome>[0], "device" | "onShowProjects">;

/**
 * The Projects list with the Task mode | Project mode switch on top. The
 * server already rendered the chosen mode; switching saves the choice for
 * this device class and reloads the list in the other mode.
 */
export function ProjectsModeView({
  mode,
  device,
  task,
  children,
}: {
  mode: ProjectViewMode;
  device: ViewDevice;
  /** Task mode's home; rendered instead of `children` when set. */
  task?: TaskHomeData | null;
  /** Project mode's list, unchanged. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const change = (next: ProjectViewMode) => {
    saveViewMode(device, next);
    startTransition(() => router.replace(`/projects?view=${next}`));
  };
  return (
    <div data-component="ProjectsModeView" data-mode={mode} className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <ModeSwitch mode={mode} onChange={change} />
      </div>
      <div aria-busy={pending || undefined} className={pending ? "opacity-60" : undefined}>
        {task ? <TaskHome {...task} device={device} onShowProjects={() => change("project")} /> : children}
      </div>
    </div>
  );
}
