"use client";

import { useEffect, useRef } from "react";

import { decorSprite } from "@/lib/aquarium/creatures";

import { createScenery, resizeScenery, stepScenery, type Pusher } from "./scenery";
import { drawScenery, loadSceneryImages } from "./sceneryDraw";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const MAX_DPR = 1.5;

export interface AquariumBackdropProps {
  /** Read once per frame: swimmers that push the seaweed aside (e.g. the creature scene's leaders). */
  pushers?: () => Iterable<Pusher> | null | undefined;
}

/**
 * The water behind the creatures: the Canva backdrop (CSS cover) plus one
 * canvas with its own rAF loop for light rays, caustics, layered seabed decor,
 * swaying seaweed, plankton and vent bubbles. Reduced motion paints one still
 * frame; a hidden tab stops the loop.
 */
export function AquariumBackdrop({ pushers }: AquariumBackdropProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pushersRef = useRef(pushers);

  useEffect(() => {
    pushersRef.current = pushers;
  }, [pushers]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    let reduced = media?.matches ?? false;
    let width = wrap.clientWidth || window.innerWidth;
    let height = wrap.clientHeight || window.innerHeight;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;
    let disposed = false;
    const scenery = createScenery(width, height);

    const paint = () => {
      if (ctx) drawScenery(ctx, scenery, { width, height, dpr, reducedMotion: reduced });
    };
    const resize = () => {
      width = wrap.clientWidth || window.innerWidth;
      height = wrap.clientHeight || window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      resizeScenery(scenery, width, height);
      if (!running) paint();
    };
    const frame = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      stepScenery(scenery, dt, { reducedMotion: reduced, pushers: pushersRef.current?.() });
      paint();
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || disposed || document.hidden) return;
      if (reduced) {
        stepScenery(scenery, 0, { reducedMotion: true });
        paint();
        return;
      }
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotion = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      stop();
      start();
    };

    resize();
    void loadSceneryImages().then(() => {
      if (!disposed && !running) paint();
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(wrap);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    media?.addEventListener?.("change", onMotion);
    start();
    return () => {
      disposed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener?.("change", onMotion);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden
      data-component="AquariumBackdrop"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-[linear-gradient(180deg,#0a6fa8_0%,#07508a_35%,#053467_70%,#031f45_100%)]"
    >
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${decorSprite("backdrop")})` }}
      />
      <canvas ref={canvasRef} data-component="AquariumScenery" className="absolute inset-0 h-full w-full" />
    </div>
  );
}
