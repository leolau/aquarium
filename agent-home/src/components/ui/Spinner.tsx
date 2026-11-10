/**
 * A rotating ring — the app's single "still working" glyph.
 *
 * Purely decorative (`aria-hidden`): whatever renders it owns the live region
 * and the human-readable label, so screen readers hear the label once instead
 * of a nameless graphic. Sized in `em` so it scales with the text it sits next
 * to, and drawn in `currentColor` so it inherits the caller's tone. Under
 * reduced motion it turns slowly instead of stopping, so it still reads as busy.
 */
export function Spinner({
  size = "sm",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dimension =
    size === "lg" ? "h-8 w-8 border-[3px]" : size === "md" ? "h-5 w-5 border-2" : "h-3.5 w-3.5 border-2";
  return (
    <span
      data-component="Spinner"
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full motion-reduce:animate-[spin_3s_linear_infinite] border-current border-t-transparent ${dimension} ${className}`}
    />
  );
}
