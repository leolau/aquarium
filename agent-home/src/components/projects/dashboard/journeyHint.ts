/**
 * The one-time coach mark on the journey bar: the create wizard leaves the
 * new project's slug here, the project page shows the hint for that slug
 * until the person dismisses it, and a dismissal is remembered for good.
 */
export const JOURNEY_HINT_PENDING = "aquarium.journeyHint.pending";
export const JOURNEY_HINT_DISMISSED = "aquarium.journeyHint.dismissed";

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function markJourneyHintPending(slug: string): void {
  const s = store();
  if (!s || s.getItem(JOURNEY_HINT_DISMISSED)) return;
  try {
    s.setItem(JOURNEY_HINT_PENDING, slug);
  } catch {
    // Storage full or blocked: the hint is a nicety, never a failure.
  }
}

export function journeyHintPending(slug: string): boolean {
  const s = store();
  if (!s || s.getItem(JOURNEY_HINT_DISMISSED)) return false;
  return s.getItem(JOURNEY_HINT_PENDING) === slug;
}

export function dismissJourneyHint(): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(JOURNEY_HINT_DISMISSED, "1");
    s.removeItem(JOURNEY_HINT_PENDING);
  } catch {
    // ignore
  }
}
