/** The Aquarium bowl icon (Gemini AI stars on a circuit frond). */
export function AquariumMark({
  size = 24,
  className,
  title = "Aquarium",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const src = size <= 24 ? "/brand/aquarium-favicon.svg" : "/brand/aquarium-icon.svg";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={size} height={size} alt={title} className={className} />
  );
}
