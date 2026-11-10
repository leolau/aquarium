import { CREATURES, type CreatureId } from "@/lib/aquarium/creatures";

/** Placeholder until the W2 drawings land; same signature. */
export function CreatureIcon({ id, size = 32 }: { id: CreatureId; size?: number }) {
  const label = CREATURES.find((c) => c.id === id)?.label ?? id;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-creature={id}>
      <circle cx="16" cy="16" r="14" fill="currentColor" opacity="0.15" />
      <text x="16" y="21" textAnchor="middle" fontSize="14" fill="currentColor">
        {label.charAt(0)}
      </text>
    </svg>
  );
}
