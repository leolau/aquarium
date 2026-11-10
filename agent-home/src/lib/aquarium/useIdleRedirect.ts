"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { IDLE_SECONDS_DEFAULT, IDLE_SECONDS_MAX, IDLE_SECONDS_MIN } from "./creatures";

export const AQUARIUM_HREF = "/aquarium";

const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "scroll",
  "touchstart",
  "focusin",
  "input",
] as const;

export function isValidIdleSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= IDLE_SECONDS_MIN && v <= IDLE_SECONDS_MAX;
}

/** `GET /api/aquarium/settings`; the default on any error or bad value. */
export async function fetchIdleSeconds(signal?: AbortSignal): Promise<number> {
  try {
    const res = await fetch("/api/aquarium/settings", { cache: "no-store", signal });
    if (!res.ok) return IDLE_SECONDS_DEFAULT;
    const body = (await res.json()) as { idle_seconds?: unknown };
    return isValidIdleSeconds(body?.idle_seconds) ? body.idle_seconds : IDLE_SECONDS_DEFAULT;
  } catch {
    return IDLE_SECONDS_DEFAULT;
  }
}

/** The page is hidden, a dialog or sheet is open, or a message box has text. */
export function pageIsBusy(doc: Document = document): boolean {
  if (doc.hidden) return true;
  if (doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) {
    return true;
  }
  return Array.from(doc.querySelectorAll("textarea")).some((el) => el.value.trim() !== "");
}

/**
 * Landing page only: opens the Aquarium dashboard after `idle_seconds` with
 * no pointer, key, wheel, scroll, touch or focus activity. Never fires while
 * `blocked` (e.g. a chat turn is streaming) or {@link pageIsBusy}; then the
 * idle period starts over.
 */
export function useIdleRedirect({ blocked = false }: { blocked?: boolean } = {}): void {
  const router = useRouter();
  const active = usePathname() === "/";
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    void fetchIdleSeconds(ac.signal).then((s) => {
      if (!ac.signal.aborted) setSeconds(s);
    });
    return () => ac.abort();
  }, [active]);

  useEffect(() => {
    if (!active || seconds === null || blocked) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, seconds * 1000);
    };
    const fire = () => {
      if (pageIsBusy(document)) arm();
      else router.push(AQUARIUM_HREF);
    };
    const opts = { capture: true, passive: true } as const;
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, arm, opts);
    document.addEventListener("visibilitychange", arm);
    arm();
    return () => {
      clearTimeout(timer);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, arm, opts);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [active, seconds, blocked, router]);
}
