import type { ReactNode } from "react";

/**
 * Landing page frame (Figma `5:2` desktop, `6:90` mobile).
 * Desktop: top bar over a 280px chats sidebar, the centre composer, and a
 * 320px needs-you/work panel. Below `lg` the sidebar moves into the Chats
 * drawer, the panel opens as a sheet, and `dock` (composer row + Chats /
 * New chat bar) sits at the bottom above the Coral launchers.
 */
export function LandingLayout({
  topBar,
  sidebar,
  main,
  aside,
  dock,
}: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
  dock?: ReactNode;
}) {
  return (
    <div data-component="LandingLayout" className="flex h-dvh flex-col">
      {/* Not sticky: a sticky wrapper is a stacking context and would trap the
          top bar's dialogs (sign-out, health) under the Coral launchers. */}
      <div style={{ paddingTop: "var(--safe-top)" }}>
        {topBar}
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        {sidebar ? (
          <aside
            data-component="landing-sidebar"
            aria-label="Chats"
            className="hidden min-h-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:block"
          >
            {sidebar}
          </aside>
        ) : (
          <div className="hidden lg:block" />
        )}
        <main
          data-component="landing-main"
          className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-6 lg:justify-center lg:px-10 lg:py-8"
        >
          {main}
        </main>
        {aside ? (
          <aside
            data-component="landing-aside"
            aria-label="Needs you and background work"
            className="hidden min-h-0 overflow-y-auto border-l border-[var(--color-border)] p-4 lg:block"
          >
            {aside}
          </aside>
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
