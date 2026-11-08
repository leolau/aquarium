/**
 * Animated Aquarium loader (2.4 s loop, CSS inside the SVG). As an <img> the
 * SVG still honours prefers-reduced-motion and needs no unique-id handling.
 */
export function AquariumLoader({
  size = 48,
  label = "Loading…",
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span role="status" aria-live="polite" className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/aquarium-loader.svg" width={size} height={size} alt="" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
