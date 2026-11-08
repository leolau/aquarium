"use client";

import Link from "next/link";

import { NeedsYouPanel } from "./NeedsYouPanel";
import { WorkPanel } from "./WorkPanel";
import { IconFolder } from "./icons";
import type { NeedsYouFeed } from "./useNeedsYouFeed";

/**
 * The landing page's right panel (Figma `work-panel`, desktop `5:2`):
 * Needs you on top, Working in the background below, Open Projects at the
 * foot. Drop it into `LandingLayout`'s `aside`.
 */
export function LandingWorkPanel({ needsYou }: { needsYou?: NeedsYouFeed }) {
  return (
    <div data-component="LandingWorkPanel" className="flex h-full min-h-0 flex-col gap-2">
      <NeedsYouPanel feed={needsYou} />
      <div aria-hidden className="h-3 shrink-0" />
      <WorkPanel />
      <div className="mt-auto pt-4">
        <Link
          href="/projects"
          data-action="open-projects"
          className="flex min-h-9 w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-[13px] font-medium leading-[18px] text-[var(--color-fg)] hover:brightness-110"
        >
          <IconFolder size={16} />
          Open Projects
        </Link>
      </div>
    </div>
  );
}
