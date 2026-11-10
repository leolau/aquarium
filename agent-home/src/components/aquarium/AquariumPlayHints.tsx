"use client";

import { useT } from "@/i18n/client";

export interface AquariumPlayHintsProps {
  /** Phone-like device: talk about tapping and shaking the phone. */
  touch: boolean;
  /** Offer the iOS "Turn on shake" button. */
  needsMotionPermission: boolean;
  triedTap: boolean;
  triedShake: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnableMotion: () => void;
  enablingMotion: boolean;
}

/** The two-line "Try this" card for tap-to-swim and shaking the tank. */
export function AquariumPlayHints({
  touch,
  needsMotionPermission,
  triedTap,
  triedShake,
  open,
  onOpenChange,
  onEnableMotion,
  enablingMotion,
}: AquariumPlayHintsProps) {
  const t = useT("aquarium");
  if (!open) {
    return (
      <button
        type="button"
        data-action="aquarium-show-tips"
        onClick={() => onOpenChange(true)}
        className="pointer-events-auto inline-flex min-h-10 items-center gap-1.5 rounded-full bg-[rgb(3_24_52/0.62)] px-3 text-xs font-semibold text-white shadow-lg backdrop-blur-sm hover:bg-[rgb(3_24_52/0.8)]"
      >
        <span aria-hidden>?</span>
        {t("play.showTips")}
      </button>
    );
  }
  const rows = [
    {
      key: "tap",
      icon: "👆",
      text: t(touch ? "play.tapTouch" : "play.tapMouse"),
      done: triedTap,
    },
    {
      key: "shake",
      icon: "〰",
      text: t(touch ? "play.shakeTouch" : "play.shakeMouse"),
      done: triedShake,
    },
  ];
  return (
    <section
      data-component="AquariumPlayHints"
      aria-label={t("play.title")}
      className="aq-hint-in pointer-events-auto w-full max-w-72 rounded-2xl border border-white/15 bg-[rgb(3_24_52/0.72)] px-3 py-2.5 text-xs text-white/90 shadow-lg backdrop-blur-sm"
    >
      <p className="font-semibold text-white">{t("play.title")}</p>
      <ul className="mt-1.5 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.key}
            data-hint={r.key}
            data-done={r.done || undefined}
            className="flex items-start gap-2"
          >
            <span
              aria-hidden
              className={`shrink-0 ${r.done ? "" : "aq-hint-pulse"}`}
            >
              {r.done ? "✓" : r.icon}
            </span>
            <span className={r.done ? "text-white/60" : undefined}>
              {r.text}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {needsMotionPermission && (
          <button
            type="button"
            data-action="aquarium-enable-shake"
            disabled={enablingMotion}
            aria-busy={enablingMotion || undefined}
            onClick={onEnableMotion}
            className="min-h-9 rounded-full bg-white/15 px-3 font-semibold text-white hover:bg-white/25 disabled:opacity-60"
          >
            {t("play.enableShake")}
          </button>
        )}
        <button
          type="button"
          data-action="aquarium-hide-tips"
          onClick={() => onOpenChange(false)}
          className="min-h-9 rounded-full px-3 font-semibold text-white/80 hover:bg-white/10 hover:text-white"
        >
          {t("play.gotIt")}
        </button>
      </div>
    </section>
  );
}
