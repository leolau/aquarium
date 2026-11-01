"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` on the server and during hydration, `true` once the client has
 * hydrated. Gate text that depends on the browser's clock, locale or time zone
 * (relative ages, `toLocaleString`) behind it so the server HTML and the first
 * client render agree — otherwise React throws #418 (text mismatch) and
 * re-renders the tree on the client. `useSyncExternalStore` re-renders right
 * after hydration with the client snapshot, with no effect-driven setState.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
