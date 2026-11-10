"use client";

import { usePersistentState } from "@/lib/use-persistent-state";

const parseFlag = (raw: string) => raw === "1";
const serializeFlag = (v: boolean) => (v ? "1" : "0");

/** Desktop collapse state of the landing side panels, remembered per browser. */
export function useLandingPanels() {
  const [chatsCollapsed, setChatsCollapsed] = usePersistentState(
    "aquarium.landing.chatsCollapsed",
    false,
    parseFlag,
    serializeFlag,
  );
  const [tasksCollapsed, setTasksCollapsed] = usePersistentState(
    "aquarium.landing.tasksCollapsed",
    false,
    parseFlag,
    serializeFlag,
  );
  return { chatsCollapsed, setChatsCollapsed, tasksCollapsed, setTasksCollapsed };
}
