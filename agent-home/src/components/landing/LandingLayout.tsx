"use client";

import type { ReactNode } from "react";

import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon, PanelRightIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";

/** Collapse state + setter for one desktop side panel. */
export interface PanelCollapse {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

const SIDEBAR_WIDTH = "280px";
const ASIDE_WIDTH = "320px";
const RAIL_WIDTH = "48px";

const EDGE_BUTTON =
  "absolute top-4 z-10 hidden h-6 w-6 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-muted)] shadow-sm hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] lg:inline-flex";

/**
 * A collapsed desktop panel: a slim rail whose button (and vertical label)
 * expands it again.
 */
function PanelRail({
  side,
  label,
  title,
  controls,
  onExpand,
}: {
  side: "left" | "right";
  label: string;
  title: string;
  controls: string;
  onExpand: () => void;
}) {
  const Icon = side === "left" ? PanelLeftIcon : PanelRightIcon;
  return (
    <button
      type="button"
      data-action={side === "left" ? "expand-chats" : "expand-tasks"}
      aria-label={title}
      aria-expanded={false}
      aria-controls={controls}
      title={title}
      onClick={onExpand}
      className="hidden h-full w-full flex-col items-center gap-3 pt-4 text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] lg:flex"
    >
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)]">
        <Icon size={18} />
      </span>
      <span aria-hidden className="text-[11px] font-semibold uppercase tracking-[0.06em] [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

/**
 * Landing page frame (Figma `5:2` desktop, `6:90` mobile).
 * Desktop: top bar over a 280px chats sidebar, the centre composer, and a
 * 320px needs-you/work panel; either side panel collapses to a 48px rail
 * (`chats` / `tasks`) and the centre takes the space. Below `lg` the sidebar
 * moves into the Chats drawer, the panel opens as a sheet, and `dock`
 * (composer row + Chats / New chat bar) sits at the bottom above the Coral
 * launchers.
 */
export function LandingLayout({
  topBar,
  sidebar,
  main,
  aside,
  dock,
  chats,
  tasks,
}: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
  dock?: ReactNode;
  chats?: PanelCollapse;
  tasks?: PanelCollapse;
}) {
  const t = useT("landing");
  const chatsCollapsed = Boolean(sidebar && chats?.collapsed);
  const tasksCollapsed = Boolean(aside && tasks?.collapsed);
  const columns = [
    chatsCollapsed ? RAIL_WIDTH : SIDEBAR_WIDTH,
    "minmax(0,1fr)",
    aside ? (tasksCollapsed ? RAIL_WIDTH : ASIDE_WIDTH) : ASIDE_WIDTH,
  ].join(" ");
  return (
    <div data-component="LandingLayout" className="relative flex h-dvh flex-col overflow-hidden">
      {/* Not sticky: a sticky wrapper is a stacking context and would trap the
          top bar's dialogs (sign-out, health) under the Coral launchers. */}
      <div style={{ paddingTop: "var(--safe-top)" }}>
        {topBar}
      </div>
      <div
        data-chats-collapsed={chatsCollapsed || undefined}
        data-tasks-collapsed={tasksCollapsed || undefined}
        style={{ gridTemplateColumns: columns }}
        className="flex min-h-0 flex-1 flex-col lg:grid motion-safe:lg:transition-[grid-template-columns] motion-safe:lg:duration-200"
      >
        {sidebar ? (
          <div className="relative hidden min-h-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:block">
            {chatsCollapsed ? (
              <PanelRail
                side="left"
                label={t("panels.chats")}
                title={t("panels.expandChats")}
                controls="landing-sidebar"
                onExpand={() => chats?.onCollapsedChange(false)}
              />
            ) : null}
            <aside
              id="landing-sidebar"
              data-component="landing-sidebar"
              aria-label="Chats"
              hidden={chatsCollapsed}
              className="relative h-full min-h-0 overflow-y-auto"
            >
              {sidebar}
            </aside>
            {chats && !chatsCollapsed ? (
              <button
                type="button"
                data-action="collapse-chats"
                aria-label={t("panels.collapseChats")}
                aria-expanded
                aria-controls="landing-sidebar"
                title={t("panels.collapseChats")}
                onClick={() => chats.onCollapsedChange(true)}
                className={`${EDGE_BUTTON} -right-3`}
              >
                <ChevronLeftIcon size={14} />
              </button>
            ) : null}
          </div>
        ) : (
          <div className="hidden lg:block" />
        )}
        <main
          data-component="landing-main"
          className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-6 lg:justify-center lg:px-10 lg:py-8"
        >
          {main}
        </main>
        {aside ? (
          <div className="relative hidden min-h-0 border-l border-[var(--color-border)] lg:block">
            {tasksCollapsed ? (
              <PanelRail
                side="right"
                label={t("panels.tasks")}
                title={t("panels.expandTasks")}
                controls="landing-aside"
                onExpand={() => tasks?.onCollapsedChange(false)}
              />
            ) : null}
            <aside
              id="landing-aside"
              data-component="landing-aside"
              aria-label="Needs you and background work"
              hidden={tasksCollapsed}
              className="relative h-full min-h-0 overflow-y-auto p-4"
            >
              {aside}
            </aside>
            {tasks && !tasksCollapsed ? (
              <button
                type="button"
                data-action="collapse-tasks"
                aria-label={t("panels.collapseTasks")}
                aria-expanded
                aria-controls="landing-aside"
                title={t("panels.collapseTasks")}
                onClick={() => tasks.onCollapsedChange(true)}
                className={`${EDGE_BUTTON} -left-3`}
              >
                <ChevronRightIcon size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {dock ? (
        <div
          data-component="landing-dock"
          className="bg-[var(--color-bg)] px-3 pt-2 pb-[calc(var(--coral-clearance)+var(--safe-bottom))] lg:hidden"
        >
          {dock}
        </div>
      ) : null}
    </div>
  );
}
