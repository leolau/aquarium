/** How long a revealed field keeps its highlight ring. */
export const HIGHLIGHT_MS = 2400;
const RETRY_MS = 50;
const MAX_TRIES = 20;

/**
 * Scroll the element with `id` into view, focus its first field and ring it
 * for a moment. Retries briefly, because the target usually lives in a tab
 * that is only being switched to.
 */
export function revealTarget(id: string, tries = MAX_TRIES): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (!el) {
    if (tries > 0) setTimeout(() => revealTarget(id, tries - 1), RETRY_MS);
    return;
  }
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
  const field = el.matches("input, textarea, select, button")
    ? el
    : el.querySelector<HTMLElement>("input, textarea, select");
  field?.focus({ preventScroll: true });
  el.setAttribute("data-journey-highlight", "true");
  setTimeout(() => el.removeAttribute("data-journey-highlight"), HIGHLIGHT_MS);
}
