"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

import { ChevronLeftIcon } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { usePersistentState } from "@/lib/use-persistent-state";
import { CREATURES, type AquariumSnapshot, type AquariumUser } from "@/lib/aquarium/creatures";

import { AquariumBackdrop } from "./AquariumBackdrop";
import { AquariumLegend } from "./AquariumLegend";
import { AquariumPlayHints } from "./AquariumPlayHints";
import { CreatureCard } from "./CreatureCard";
import { drawScene } from "./render";
import {
  applySnapshot,
  createScene,
  hitTest,
  locate,
  sameTarget,
  sceneBounds,
  shakeScene,
  steerSelfTo,
  stepScene,
  type Bounds,
  type HitTarget,
  type Scene,
} from "./scene";
import { createShakeDetector, motionSupport, requestMotion, type MotionSupport } from "./shake";
import { startSnapshotPolling, type SnapshotPollerOptions } from "./snapshot";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const CARD_W = 224;
/** How long the tank visibly shakes before everyone changes course. */
export const SHAKE_MS = 2500;
const SHAKE_MS_REDUCED = 400;
const NOTICE_MS = 2600;
const TIPS_KEY = "aq-aquarium-tips";
const parseTipsHidden = (raw: string) => raw === "hidden";
const serializeTipsHidden = (hidden: boolean) => (hidden ? "hidden" : "open");
const noSubscribe = () => () => {};
const isCoarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
const noMotion = (): MotionSupport => "none";

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
  const [selected, setSelectedState] = useState<HitTarget | null>(null);
  const reducedRef = useRef(false);
  const shakingRef = useRef(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shaking, setShaking] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const touch = useSyncExternalStore(noSubscribe, isCoarsePointer, () => false);
  const support = useSyncExternalStore(noSubscribe, motionSupport, noMotion);
  const [motionAnswer, setMotionAnswer] = useState<boolean | null>(null);
  const [enablingMotion, setEnablingMotion] = useState(false);
  const [tipsHidden, setTipsHidden] = usePersistentState(TIPS_KEY, false, parseTipsHidden, serializeTipsHidden);
  const motionOn = touch && (support === "ready" || motionAnswer === true);
  const needsMotion = touch && support === "needs-permission" && motionAnswer === null;
  const [triedTap, setTriedTap] = useState(false);
  const [triedShake, setTriedShake] = useState(false);

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
      setOffline(false);
    };
    return startSnapshotPolling({ load, onSnapshot, onError: () => setOffline(true) });
  }, [load, scene]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    let reduced = media?.matches ?? false;
    reducedRef.current = reduced;
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
      reducedRef.current = reduced;
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

  const showNotice = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const shake = useCallback(() => {
    if (shakingRef.current) return;
    shakingRef.current = true;
    setShaking(true);
    setTriedShake(true);
    shakeTimer.current = setTimeout(
      () => {
        shakeScene(scene(), boundsRef.current, { reducedMotion: reducedRef.current });
        shakingRef.current = false;
        setShaking(false);
        showNotice(t("play.shaken"));
      },
      reducedRef.current ? SHAKE_MS_REDUCED : SHAKE_MS,
    );
  }, [scene, showNotice, t]);
  const shakeRef = useRef(shake);
  useEffect(() => {
    shakeRef.current = shake;
  }, [shake]);

  useEffect(
    () => () => {
      if (shakeTimer.current) clearTimeout(shakeTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!motionOn) return;
    const feed = createShakeDetector();
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      if (feed({ x: a.x, y: a.y, z: a.z, t: e.timeStamp || performance.now() })) shakeRef.current();
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [motionOn]);

  const enableMotion = async () => {
    if (enablingMotion) return;
    setEnablingMotion(true);
    const ok = await requestMotion();
    setEnablingMotion(false);
    setMotionAnswer(ok);
    if (!ok) showNotice(t("play.motionDenied"));
  };

  const steer = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setRipple((r) => ({ x, y, key: (r?.key ?? 0) + 1 }));
    setTriedTap(true);
    if (!steerSelfTo(scene(), x, y, boundsRef.current)) showNotice(t("play.noSelf"));
  };

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
    steer(e);
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
      <div
        data-component="AquariumTank"
        data-shaking={shaking || undefined}
        className={`absolute inset-0 ${shaking ? "aq-tank-shake" : ""}`}
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
        {ripple && (
          <span
            key={ripple.key}
            data-component="AquariumTapRipple"
            aria-hidden
            onAnimationEnd={() => setRipple(null)}
            className="aq-tap-ripple pointer-events-none absolute h-16 w-16 rounded-full border-2 border-white/80 shadow-[0_0_18px_rgb(255_255_255/0.45)]"
            style={{ left: ripple.x, top: ripple.y }}
          />
        )}
        {selectedUser && <CreatureCard ref={cardRef} user={selectedUser} profile={selected?.profile} />}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          href="/"
          data-action="aquarium-back"
          className="pointer-events-auto inline-flex min-h-10 items-center gap-1 rounded-full bg-[rgb(3_24_52/0.62)] px-3 text-sm font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-[rgb(3_24_52/0.8)]"
        >
          <ChevronLeftIcon size={16} aria-hidden />
          {t("back")}
        </Link>
        <h1 className="sr-only">{t("title")}</h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {offline && (
            <span
              data-component="AquariumOffline"
              role="status"
              className="pointer-events-auto rounded-full bg-[rgb(120_20_30/0.75)] px-3 py-1 text-xs font-semibold text-white shadow-lg"
            >
              {t("offline")}
            </span>
          )}
          <button
            type="button"
            data-action="aquarium-shake"
            onClick={shake}
            disabled={shaking}
            aria-busy={shaking || undefined}
            aria-label={shaking ? t("play.shaking") : t("play.shakeLabel")}
            title={t("play.shakeLabel")}
            className="pointer-events-auto inline-flex min-h-10 items-center gap-1.5 rounded-full bg-[rgb(3_24_52/0.62)] px-3 text-sm font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-[rgb(3_24_52/0.8)] disabled:cursor-wait disabled:opacity-70"
          >
            <span aria-hidden className={shaking ? "" : "aq-hint-pulse inline-block"}>
              〰
            </span>
            {shaking ? t("play.shaking") : t("play.shake")}
          </button>
        </div>
      </div>

      <p
        role="status"
        data-component="AquariumNotice"
        className={`pointer-events-none absolute inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] z-20 flex justify-center px-3 ${notice ? "" : "sr-only"}`}
      >
        {notice && (
          <span className="aq-hint-in rounded-full bg-[rgb(3_24_52/0.8)] px-3 py-1.5 text-center text-xs font-semibold text-white shadow-lg backdrop-blur-sm">
            {notice}
          </span>
        )}
      </p>

      <div className="pointer-events-none absolute right-0 bottom-0 z-10 flex justify-end p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] max-sm:bottom-auto max-sm:left-0">
        <AquariumPlayHints
          touch={touch}
          needsMotionPermission={needsMotion}
          triedTap={triedTap}
          triedShake={triedShake}
          open={!tipsHidden}
          onOpenChange={(open) => setTipsHidden(!open)}
          onEnableMotion={enableMotion}
          enablingMotion={enablingMotion}
        />
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
