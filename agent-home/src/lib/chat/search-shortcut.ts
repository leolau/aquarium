"use client";

import { useEffect, useRef } from "react";

/** True when keystrokes are going into a text field the user is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** `/` (no modifiers) or Ctrl/Cmd+K, outside any text field. */
export function isSearchShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || isTypingTarget(e.target)) return false;
  if (e.key === "/") return !e.ctrlKey && !e.metaKey && !e.altKey;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
}

/** Calls `onTrigger` when the chat search shortcut is pressed anywhere on the page. */
export function useSearchShortcut(onTrigger: () => void): void {
  const ref = useRef(onTrigger);
  useEffect(() => {
    ref.current = onTrigger;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
