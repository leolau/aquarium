"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { InfoIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { LEGEND_HIDE_MS } from "@/lib/aquarium/creatures";

import { CreatureIcon } from "./CreatureIcon";

const ROWS = ["size", "speed", "followers", "active", "self"] as const;
type Row = (typeof ROWS)[number];

function Swatch({ row }: { row: Row }): ReactNode {
  switch (row) {
    case "size":
      return (
        <>
          <CreatureIcon id="clownfish" size={14} className="self-end" />
          <CreatureIcon id="clownfish" size={30} />
        </>
      );
    case "speed":
      return (
        <>
          <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden className="text-white">
            <path d="M2 4h9M5 8h9M2 12h9" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          </svg>
          <CreatureIcon id="clownfish" size={24} />
        </>
      );
    case "followers":
      return (
        <>
          <CreatureIcon id="seahorse" size={12} className="self-end" />
          <CreatureIcon id="blue-tang" size={14} />
          <CreatureIcon id="clownfish" size={24} />
        </>
      );
    case "active":
      return (
        <span className="relative">
          <CreatureIcon id="clownfish" size={26} className="drop-shadow-[0_0_5px_#8cffec]" />
          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full border border-white bg-white/40" />
          <span className="absolute -top-2 right-1.5 h-1 w-1 rounded-full border border-white bg-white/40" />
        </span>
      );
    case "self":
      return (
        <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#ffd84a] shadow-[0_0_8px_#ffd84a]">
          <CreatureIcon id="clownfish" size={22} />
        </span>
      );
  }
}

/** Pointer clicks leave focus on the info button; only keyboard focus should keep the legend up. */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface AquariumLegendProps {
  /** How long the legend stays up after it opens (tests shorten it). */
  hideAfterMs?: number;
}

/**
 * Key to what size, speed, the followers, the glow and the gold ring mean.
 * Shown on load, fades out after `LEGEND_HIDE_MS` (not while hovered or
 * focused); the info button brings it back. Reduced motion hides it without
 * the fade.
 */
export function AquariumLegend({ hideAfterMs = LEGEND_HIDE_MS }: AquariumLegendProps) {
  const t = useT("aquarium");
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;

  useEffect(() => {
    if (!open || held) return;
    const timer = setTimeout(() => setOpen(false), hideAfterMs);
    return () => clearTimeout(timer);
  }, [open, held, hideAfterMs]);

  return (
    <div
      ref={wrapRef}
      data-component="AquariumLegend"
      data-state={open ? "open" : "closed"}
      className="pointer-events-none flex flex-col items-start gap-2"
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(e) => setFocused(isKeyboardFocus(e.target))}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <section
        id={panelId}
        aria-label={t("legend.title")}
        className={`max-w-72 rounded-2xl bg-[rgb(3_24_52/0.78)] px-3 py-2.5 text-xs text-white shadow-lg ring-1 ring-white/20 backdrop-blur-md transition-[opacity,transform,visibility] duration-700 ease-out motion-reduce:transition-none ${
          open ? "pointer-events-auto visible translate-y-0 opacity-100" : "invisible translate-y-2 opacity-0"
        }`}
      >
        <h2 className="mb-2 text-sm font-semibold">{t("legend.title")}</h2>
        <ul className="space-y-1.5">
          {ROWS.map((row) => (
            <li key={row} data-legend-row={row} className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="flex h-9 w-14 shrink-0 items-center justify-center gap-0.5 rounded-lg bg-[rgb(120_190_255/0.18)] ring-1 ring-white/25"
              >
                <Swatch row={row} />
              </span>
              <span className="leading-snug text-white/95">{t(`legend.${row}`)}</span>
            </li>
          ))}
        </ul>
      </section>
      <button
        type="button"
        data-action="aquarium-legend-toggle"
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={open ? t("legend.hide") : t("legend.show")}
        title={open ? t("legend.hide") : t("legend.show")}
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-[rgb(3_24_52/0.62)] text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm hover:bg-[rgb(3_24_52/0.85)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <InfoIcon size={18} aria-hidden />
      </button>
    </div>
  );
}
