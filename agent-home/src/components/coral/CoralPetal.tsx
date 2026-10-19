"use client";

import type { CSSProperties } from "react";
import Link from "next/link";

import { NavGlyph } from "@/components/NavGlyph";
import type { AppManifest } from "@/components/coral/coral-types";
import { useT } from "@/i18n";

/**
 * One launcher tile: glyph in a circle with the FULL label underneath —
 * the grid layout guarantees tiles never overlap, so names stay readable
 * instead of being squeezed into a radial arc (the first Coral design's
 * failure mode, seen live 2026-08-23).
 */
export function CoralTile({
  app,
  active,
  badgeCount,
  delayMs,
  onClose,
}: {
  app: AppManifest;
  active: boolean;
  badgeCount?: number;
  delayMs: number;
  onClose: () => void;
}) {
  const t = useT("nav");
  const name = t.has(`apps.${app.id}.name`) ? t(`apps.${app.id}.name`) : app.name;
  const hint = t.has(`apps.${app.id}.hint`) ? t(`apps.${app.id}.hint`) : app.hint;
  return (
    <Link
      href={app.route}
      onClick={onClose}
      role="menuitem"
      aria-current={active ? "page" : undefined}
      title={hint ?? name}
      className="coral-tile relative flex flex-col items-center gap-1 rounded-xl px-1 py-2 hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      style={{ "--coral-delay": `${delayMs}ms` } as CSSProperties}
    >
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-full border text-xl ${
          active
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-border)] text-[var(--color-text)]"
        }`}
      >
        <NavGlyph glyph={app.glyph} />
      </span>
      <span className="w-full truncate text-center text-[11px] leading-tight text-[var(--color-text)]">
        {name}
      </span>
      {badgeCount ? (
        <span className="absolute right-1 top-0 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] leading-4 text-[var(--color-accent-fg)]">
          {badgeCount}
        </span>
      ) : null}
    </Link>
  );
}
