"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { ChevronLeftIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { CREATURES, type AquariumSnapshot, type AquariumUser } from "@/lib/aquarium/creatures";

import { AquariumBackdrop } from "./AquariumBackdrop";
import { AquariumLegend } from "./AquariumLegend";
import { AquariumTitle } from "./AquariumTitle";
import { CreatureCard } from "./CreatureCard";
import { drawScene } from "./render";
import {
  applySnapshot,
  createScene,
  hitTest,
  locate,
  sameTarget,
  sceneBounds,
  stepScene,
  type Bounds,
  type HitTarget,
  type Scene,
} from "./scene";
import { startSnapshotPolling, type SnapshotPollerOptions } from "./snapshot";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const CARD_W = 224;

export interface AquariumViewProps {
  /** Test seam: replaces the `GET /api/aquarium` fetch. */
  load?: SnapshotPollerOptions["load"];
}

/**
 * FG-35 — the whole box as an aquarium. One rAF loop steps the scene and
 * paints a single canvas; React state only changes per snapshot (every 5 s)
 * and when the pointer moves onto a different creature.
 */
export function AquariumView({ load }: AquariumViewProps) {
  const t = useT("aquarium");
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const boundsRef = useRef<Bounds>(sceneBounds(1024, 768));
  const selectedRef = useRef<HitTarget | null>(null);
  const pinnedRef = useRef(false);
  const [users, setUsers] = useState<AquariumUser[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [selected, setSelectedState] = useState<HitTarget | null>(null);

  const scene = useCallback((): Scene => (sceneRef.current ??= createScene()), []);

  const select = useCallback((next: HitTarget | null) => {
    if (sameTarget(selectedRef.current, next)) return;
    selectedRef.current = next;
    setSelectedState(next);
    if (canvasRef.current) canvasRef.current.style.cursor = next ? "pointer" : "";
  }, []);

  useEffect(() => {
    const onSnapshot = (snap: AquariumSnapshot) => {
      applySnapshot(scene(), snap, boundsRef.current);
      setUsers(snap.users);
      setName(snap.name);
      setOffline(false);
    };
    return startSnapshotPolling({ load, onSnapshot, onError: () => setOffline(true) });
  }, [load, scene]);

  useEffect(() => {
    if (!name) return;
    const previous = document.title;
    document.title = name;
    return () => {
      document.title = previous;
    };
  }, [name]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    let reduced = media?.matches ?? false;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;

    const resize = () => {
      const w = wrap.clientWidth || window.innerWidth;
      const h = wrap.clientHeight || window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      boundsRef.current = sceneBounds(w, h);
    };

    const placeCard = () => {
      const card = cardRef.current;
      const target = selectedRef.current;
      if (!card) return;
      const s = target ? locate(scene(), target) : null;
      if (!s) {
        card.style.opacity = "0";
        return;
      }
      const b = boundsRef.current;
      const right = s.x + s.size / 2 + 12;
      const x = right + CARD_W > b.width - 8 ? s.x - s.size / 2 - 12 - CARD_W : right;
      const y = Math.max(8, Math.min(b.height - card.offsetHeight - 8, s.y - 40));
      card.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
      card.style.opacity = "1";
    };

    const frame = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const s = scene();
      const b = boundsRef.current;
      stepScene(s, dt, b, { reducedMotion: reduced });
      if (ctx) drawScene(ctx, s, { width: b.width, height: b.height, dpr, reducedMotion: reduced, selected: selectedRef.current });
      placeCard();
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || document.hidden) return;
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
    };

    resize();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(wrap);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    media?.addEventListener?.("change", onMotion);
    start();
    return () => {
      stop();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener?.("change", onMotion);
    };
  }, [scene]);

  const pointAt = (e: PointerEvent<HTMLCanvasElement>): HitTarget | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    return hitTest(scene(), e.clientX - rect.left, e.clientY - rect.top, e.pointerType === "mouse" ? 4 : 14);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== "mouse" || pinnedRef.current) return;
    select(pointAt(e));
  };
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const hit = pointAt(e);
    pinnedRef.current = hit !== null && (e.pointerType !== "mouse" || !sameTarget(hit, selectedRef.current) || !pinnedRef.current);
    select(hit);
  };
  const onPointerLeave = () => {
    if (!pinnedRef.current) select(null);
  };

  const selectedUser = useMemo(
    () => (selected && users ? (users.find((u) => u.user_id === selected.userId) ?? null) : null),
    [selected, users],
  );

  return (
    <div
      ref={wrapRef}
      data-component="AquariumView"
      className="fixed inset-0 z-0 overflow-hidden bg-[#053467] text-white select-none"
    >
      <AquariumBackdrop />
      <canvas
        ref={canvasRef}
        data-component="AquariumCanvas"
        aria-hidden
        className="absolute inset-0 h-full w-full touch-manipulation"
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerLeave={onPointerLeave}
      />
      {selectedUser && <CreatureCard ref={cardRef} user={selectedUser} profile={selected?.profile} />}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-start gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/"
          data-action="aquarium-back"
          className="pointer-events-auto inline-flex min-h-10 items-center gap-1 justify-self-start rounded-full bg-[rgb(3_24_52/0.62)] px-3 text-sm font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-[rgb(3_24_52/0.8)]"
        >
          <ChevronLeftIcon size={16} aria-hidden />
          {t("back")}
        </Link>
        <div className="min-w-0 max-w-[min(64vw,44rem)] justify-self-center pt-0.5 text-center">
          {name ? <AquariumTitle name={name} /> : <h1 className="sr-only">{t("title")}</h1>}
        </div>
        {offline && (
          <span
            data-component="AquariumOffline"
            role="status"
            className="pointer-events-auto justify-self-end rounded-full bg-[rgb(120_20_30/0.75)] px-3 py-1 text-xs font-semibold text-white shadow-lg"
          >
            {t("offline")}
          </span>
        )}
      </div>

      <div className="absolute bottom-0 left-0 z-10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <AquariumLegend />
      </div>

      {users !== null && users.length === 0 && (
        <p data-component="AquariumEmpty" className="absolute inset-x-0 top-1/3 z-10 text-center text-sm text-white/80">
          {t("empty")}
        </p>
      )}

      <ul data-component="AquariumPeople" aria-label={t("peopleList")} className="sr-only">
        {(users ?? []).map((u) => (
          <li key={u.user_id}>
            {t("person", {
              name: u.name,
              creature: CREATURES.find((c) => c.id === u.creature)?.label ?? u.creature,
              chats: u.metrics.chats,
              profiles: u.profiles.length,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
