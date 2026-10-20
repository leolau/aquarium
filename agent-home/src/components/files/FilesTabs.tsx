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
      className="mb-4 inline-flex gap-1 self-start rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-sm"
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
                ? "rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[var(--color-accent-fg)]"
                : "rounded-lg px-3 py-1.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
