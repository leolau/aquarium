"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { routeTrail, type Crumb } from "@/lib/nav/route-trail";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Tap-to-open explanation next to the title (an `InfoTip`). */
  info?: ReactNode;
  actions?: ReactNode;
  /** Override the logical parent (e.g. a project's name). */
  back?: Crumb;
  /** Crumb label overrides by href, e.g. `{ "/projects/x": "Tender bids" }`. */
  labels?: Record<string, string>;
}

/**
 * Figma `page-header` (15:241): the back row under the landing top bar.
 * Back always goes to the logical parent (never browser history); desktop
 * shows the full trail as a breadcrumb, phones show only Back.
 */
export function PageHeader({ title, subtitle, info, actions, back, labels }: PageHeaderProps) {
  const pathname = usePathname() ?? "/";
  const trail = routeTrail(pathname, labels);
  const parent = back ?? (trail.length > 1 ? trail[trail.length - 2] : null);
  const crumbs = back ? [...trail.slice(0, -2), back] : trail.slice(0, -1);

  return (
    <header data-component="PageHeader" className="mb-4 flex flex-col gap-1">
      {parent ? (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] text-[var(--color-muted)]">
          <Link
            href={parent.href}
            data-action="back"
            className="-ml-2 inline-flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] lg:h-8"
          >
            <ChevronLeftIcon size={18} />
            <span className="lg:sr-only">{parent.label}</span>
            <span className="sr-only lg:hidden">Back</span>
          </Link>
          <ol className="hidden min-w-0 items-center gap-1 lg:flex">
            {crumbs.map((c, i) => (
              <li key={c.href} className="flex min-w-0 items-center gap-1">
                {i > 0 ? <ChevronRightIcon size={14} /> : null}
                <Link href={c.href} className="truncate hover:text-[var(--color-fg)] hover:underline">
                  {c.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <h1 className="min-w-0 text-xl font-semibold tracking-tight text-[var(--color-fg)] [overflow-wrap:anywhere] lg:text-2xl">
            {title}
          </h1>
          {info}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-sm text-[var(--color-muted)]">{subtitle}</p> : null}
    </header>
  );
}
