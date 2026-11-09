import { useId } from "react";

// Star boxes as % of the 491×360 signin-welcome artwork, so the animated
// stars sit exactly where the static illustration draws them.
const STARS = [
  { left: 4.28, top: 0, width: 11.2, height: 16.39, delay: 0 },
  { left: 87.98, top: 13.33, width: 9.98, height: 14.72, delay: -1.2 },
  { left: 0, top: 33.33, width: 5.5, height: 8.33, delay: -2.4 },
  { left: 94.3, top: 45.56, width: 5.7, height: 8.61, delay: -0.6 },
] as const;

/**
 * The sign-in fishbowl, animated in the loader's motion language: the bowl
 * floats and the AI stars grow and glow in turn. CSS only (`.aq-bowl*` in
 * globals.css); under `prefers-reduced-motion` it only fades in. Decorative,
 * and sized by the image's intrinsic ratio, so it never shifts layout.
 */
export function AuthBowl({ className = "" }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  return (
    <span
      data-component="AuthBowl"
      aria-hidden="true"
      className={`aq-bowl relative inline-block shrink-0 ${className}`}
    >
      <span className="aq-bowl-float block h-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, already optimised */}
        <img
          src="/brand/illustrations/signin-bowl.webp"
          alt=""
          width={491}
          height={360}
          className="block h-full w-auto max-w-full object-contain"
        />
      </span>
      {STARS.map((s, i) => (
        <svg
          key={i}
          className="aq-bowl-star"
          viewBox="0 0 24 26"
          preserveAspectRatio="none"
          style={{
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: `${s.width}%`,
            height: `${s.height}%`,
            animationDelay: `${s.delay}s`,
          }}
        >
          <defs>
            <linearGradient id={`${uid}-s${i}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#5b8cff" />
              <stop offset="1" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          <path
            d="M12 0C12.9 8 15.6 11.8 24 13C15.6 14.2 12.9 18 12 26C11.1 18 8.4 14.2 0 13C8.4 11.8 11.1 8 12 0Z"
            fill={`url(#${uid}-s${i})`}
          />
        </svg>
      ))}
    </span>
  );
}
