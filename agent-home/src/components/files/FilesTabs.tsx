"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useT } from "@/i18n";

const TABS = [
  { href: "/files", key: "tabs.arrived" },
  { href: "/files/browse", key: "tabs.browse" },
  { href: "/files/bridge", key: "tabs.bridge" },
] as const;

/** Arrived · Browse · Folder bridge — the three views under Files. */
export function FilesTabs() {
  const t = useT("filesBrowse");
  const pathname = usePathname();
  return (
    <nav
      data-component="FilesTabs"
      aria-label={t("tabs.label")}
      className="mb-4 grid w-full grid-cols-3 gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-sm sm:inline-grid sm:w-auto"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex min-h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-center font-semibold text-[var(--color-accent-fg)]"
                : "flex min-h-10 items-center justify-center rounded-[var(--radius-md)] px-3 text-center text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
