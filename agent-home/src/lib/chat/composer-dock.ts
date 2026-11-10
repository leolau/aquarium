/**
 * The lead-chat launcher floats at the bottom-right corner, which is where a
 * docked composer keeps its Send controls. Each mounted composer reports how
 * high it reaches from the bottom of the viewport; the launcher floats above
 * the tallest one so it never covers them (desktop or phone).
 */
import { useSyncExternalStore } from "react";

/** The launcher's footprint from the bottom-right corner (h-14 + 1rem gap, plus slack). */
const LAUNCHER_ZONE_PX = 96;

const docked = new Map<symbol, HTMLElement>();
const listeners = new Set<() => void>();
let clearance = 0;

/** How far `el` reaches up from the viewport bottom, if it sits under the launcher. */
export function composerClearance(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  if (r.height === 0 || r.width === 0) return 0;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  if (r.bottom < vh - LAUNCHER_ZONE_PX || r.right < vw - LAUNCHER_ZONE_PX)
    return 0;
  return Math.max(0, Math.round(vh - r.top));
}

function recompute() {
  let next = 0;
  for (const el of docked.values())
    next = Math.max(next, composerClearance(el));
  if (next === clearance) return;
  clearance = next;
  for (const fn of listeners) fn();
}

/** Register a composer; returns the undock function (call on unmount). */
export function dockComposer(el: HTMLElement): () => void {
  const key = Symbol("composer");
  docked.set(key, el);
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(recompute);
  observer?.observe(el);
  window.addEventListener("resize", recompute);
  recompute();
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", recompute);
    docked.delete(key);
    recompute();
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Pixels the launcher must keep clear of at the bottom of the viewport (0 = none). */
export function useComposerClearance(): number {
  return useSyncExternalStore(
    subscribe,
    () => clearance,
    () => 0,
  );
}
