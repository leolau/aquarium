import type { ReactNode } from "react";

/**
 * The page frame of {@link MobileShell}: sticky title bar, centred column and
 * launcher clearance. Kept free of server-only data so a client boundary
 * (`app/error.tsx`) can draw the same frame; MobileShell fills the slots.
 */
export function ShellFrame({
  title,
  children,
  wide = false,
  fill = false,
  clearLauncher = false,
  headerEnd,
  belowHeader,
  overlays,
  topBar,
  pageHeader,
}: {
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  fill?: boolean;
  /** Reserve bottom space for the floating launcher. */
  clearLauncher?: boolean;
  /** Right-aligned header content (profile switcher, page actions). */
  headerEnd?: ReactNode;
  /** Strips rendered between the header and the page. */
  belowHeader?: ReactNode;
  /** Floating hosts mounted after the page (launcher, lead chat). */
  overlays?: ReactNode;
  /** Replaces the title bar with the landing top bar (inner pages). */
  topBar?: ReactNode;
  /** Back row + title rendered at the top of the content column. */
  pageHeader?: ReactNode;
}) {
  const contentWidth = wide ? "lg:max-w-7xl" : "lg:max-w-5xl";
  return (
    <div data-component="MobileShell" className={`${fill ? "h-dvh" : "min-h-dvh"} bg-[var(--color-bg)]`}>
      <div className={`mx-auto flex ${fill ? "h-dvh" : "min-h-dvh"} w-full max-w-md flex-col md:max-w-2xl lg:max-w-none`}>
        {topBar ? (
          <div className="sticky top-0 z-20 bg-[var(--color-bg)]" style={{ paddingTop: "var(--safe-top)" }}>
            {topBar}
          </div>
        ) : (
          <header
            className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-4 py-3 backdrop-blur lg:px-8"
            style={{ paddingTop: "calc(var(--safe-top) + 0.75rem)" }}
          >
            <div className={`mx-auto flex w-full max-w-2xl items-center justify-between gap-2 ${contentWidth}`}>
              <h1 className="text-base font-semibold tracking-tight lg:text-lg">
                {title}
              </h1>
              {headerEnd}
            </div>
          </header>
          )}
        {belowHeader}
        <main
          className={`flex-1 px-4 py-4 lg:px-8 ${
            fill ? "flex min-h-0 flex-col overflow-y-auto" : ""
          } ${
            clearLauncher
              ? "pb-[calc(var(--coral-clearance)+var(--safe-bottom)+1rem)] lg:pb-8"
              : "pb-[calc(var(--safe-bottom)+1rem)]"
          }`}
        >
          <div
            className={`mx-auto w-full max-w-2xl ${contentWidth} ${
              fill ? "flex min-h-0 flex-1 flex-col" : ""
            }`}
          >
            {pageHeader}
            {children}
          </div>
        </main>
        {overlays}
      </div>
    </div>
  );
}
