import type { CreatureId } from "@/lib/aquarium/creatures";

import { CREATURE_ART, VIEWBOX } from "./creatures";

export interface CreatureIconProps {
  id: CreatureId;
  size?: number;
  /** Accessible name. Omit when a visible label sits next to the icon (decorative). */
  label?: string;
  className?: string;
}

/** One of the 20 FG-35 creatures as an inline SVG, facing right. */
export function CreatureIcon({ id, size = 48, label, className }: CreatureIconProps) {
  const art = CREATURE_ART[id];
  if (!art) return null;
  const decorative = !label;
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      width={size}
      height={size}
      className={className}
      data-creature={id}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      {art.parts.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ?? "none"}
          stroke={p.stroke}
          strokeWidth={p.stroke ? (p.width ?? 1) : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={p.opacity}
        />
      ))}
    </svg>
  );
}
