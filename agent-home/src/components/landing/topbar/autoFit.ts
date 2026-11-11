"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Ways the top bar can shrink, least important first. Each step is a token
 * added to the bar's `data-fit`; `globals.css` hides or swaps the matching
 * `data-fit-hide` / `data-fit-show` pieces.
 */
export const FIT_STEPS = ["updated", "aquarium-label", "health", "needs-text", "identity", "brand-label"] as const;

/** True when the bar's content no longer fits: it scrolls, a watched piece clips, two items overlap, or the last runs into the padding. */
export function overflowing(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  for (const w of Array.from(el.querySelectorAll<HTMLElement>("[data-fit-watch]"))) {
    const shown = typeof w.checkVisibility === "function" ? w.checkVisibility() : true;
    if (shown && w.scrollWidth > w.clientWidth + 1) return true;
  }
  let prevRight = -Infinity;
  for (const child of Array.from(el.children)) {
    const r = child.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.left < prevRight - 1) return true;
    prevRight = r.right;
  }
  const box = el.getBoundingClientRect();
  if (box.width > 0 && prevRight > box.right - (parseFloat(getComputedStyle(el).paddingRight) || 0) + 1) return true;
  return false;
}

/** Re-fits from the full layout, adding steps until nothing overflows. Returns the steps applied. */
export function fitBar(el: HTMLElement, steps: readonly string[] = FIT_STEPS): string[] {
  const applied: string[] = [];
  el.removeAttribute("data-fit");
  while (applied.length < steps.length && overflowing(el)) {
    applied.push(steps[applied.length]);
    el.setAttribute("data-fit", applied.join(" "));
  }
  return applied;
}

/** Keeps the referenced bar fitted as the window, fonts or its content change. */
export function useAutoFit<T extends HTMLElement>(steps: readonly string[] = FIT_STEPS) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const run = () => {
      frame = 0;
      fitBar(el, steps);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    run();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(el);
    const mutation = new MutationObserver(schedule);
    mutation.observe(el, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    let alive = true;
    document.fonts?.ready.then(() => alive && schedule()).catch(() => {});
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [steps]);
  return ref;
}
