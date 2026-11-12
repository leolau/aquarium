"use client";

import { useEffect } from "react";

/** Less than this between the layout and visual viewport is browser chrome, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Whether an on-screen keyboard covers the page: a text field has focus and
 * the visual viewport is clearly shorter than the layout viewport (iOS keeps
 * the layout viewport full height when the keyboard opens).
 */
export function keyboardOpen(layoutHeight: number, visualHeight: number, editableFocused: boolean): boolean {
  return editableFocused && layoutHeight - visualHeight > KEYBOARD_MIN_PX;
}

/**
 * Tracks `window.visualViewport` and mirrors it onto `<html>`:
 * `--vv-height` / `--vv-top` (the visible area above the keyboard) and
 * `data-keyboard="open"` while a keyboard covers the page. CSS uses them to
 * pin a fill page to the visible area and fold away chrome on phones.
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
      root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
      if (keyboardOpen(window.innerHeight, vv.height, isEditable(document.activeElement))) {
        root.dataset.keyboard = "open";
      } else {
        delete root.dataset.keyboard;
      }
    };
    // Focus moves before the keyboard animates; re-read once it has settled.
    const later = () => requestAnimationFrame(update);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      delete root.dataset.keyboard;
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-top");
    };
  }, []);
}

/** Mount point for {@link useKeyboardViewport} inside server-rendered shells. */
export function KeyboardViewport(): null {
  useKeyboardViewport();
  return null;
}
