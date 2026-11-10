import { creatureSprite, isCreatureId, type CreatureId } from "@/lib/aquarium/creatures";

export interface CreatureIconProps {
  id: CreatureId;
  size?: number;
  /** Accessible name. Omit when a visible label sits next to the icon (decorative). */
  label?: string;
  className?: string;
}

/** One of the FG-35 creatures as its Canva sprite, facing right, letterboxed into a `size` square. */
export function CreatureIcon({ id, size = 48, label, className }: CreatureIconProps) {
  if (!isCreatureId(id)) return null;
  const decorative = !label;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static sprite, already optimised WebP
    <img
      src={creatureSprite(id)}
      width={size}
      height={size}
      alt={decorative ? "" : label}
      aria-hidden={decorative ? true : undefined}
      data-creature={id}
      draggable={false}
      decoding="async"
      loading="lazy"
      className={`inline-block shrink-0 object-contain ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}
