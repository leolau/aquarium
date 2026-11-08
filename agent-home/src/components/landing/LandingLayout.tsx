import type { ReactNode } from "react";

/**
 * Landing page frame (Figma `5:2` desktop, `6:90` mobile).
 * Desktop: top bar over a 280px chats sidebar, the centre composer, and a
 * 320px needs-you/work panel. Below `lg` the sidebar moves into the Chats
 * drawer and the panel stacks under the composer.
 */
export function LandingLayout({
  topBar,
  sidebar,
  main,
  aside,
}: {
  topBar: ReactNode;
  sidebar?: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div data-component="LandingLayout" className="flex min-h-dvh flex-col lg:h-dvh">
      <div className="sticky top-0 z-20 lg:static" style={{ paddingTop: "var(--safe-top)" }}>
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
          className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8 lg:px-10"
        >
          {main}
        </main>
        {aside ? (
          <aside
            data-component="landing-aside"
            aria-label="Needs you and background work"
            className="min-h-0 overflow-y-auto border-t border-[var(--color-border)] px-4 py-4 pb-[calc(var(--coral-clearance)+var(--safe-bottom)+1rem)] lg:border-l lg:border-t-0 lg:pb-4"
          >
            {aside}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
