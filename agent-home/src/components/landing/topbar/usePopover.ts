"use client";

import { useEffect, useRef, useState } from "react";

/** Open state for an anchored popover: Esc and an outside press close it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      // A modal opened from the popover (e.g. sign-out confirm) is portalled to
      // <body>; pressing inside it must not close the popover and unmount it.
      const inModal = target instanceof Element && target.closest('[aria-modal="true"]');
      if (ref.current && !ref.current.contains(target) && !inModal) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);
  return { open, setOpen, ref };
}
