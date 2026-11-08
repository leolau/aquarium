"use client";

import type { ReactNode } from "react";

import { AquariumMark } from "@/components/brand/AquariumMark";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useT } from "@/i18n/client";

/**
 * The branded signed-out frame (Figma "Inner — Sign-in & edge states"): the
 * Aquarium mark top-left, the language switch top-right, one centred column
 * and a quiet footer. No launcher, health or account controls — nobody is
 * signed in yet — and no Back: these are entry pages.
 */
export function AuthLayout({
  children,
  wide = false,
  component,
}: {
  children: ReactNode;
  /** 860 px for the five-step owner setup; 420 px otherwise. */
  wide?: boolean;
  component?: string;
}) {
  const t = useT("auth");
  return (
    <div
      data-component={component ?? "AuthLayout"}
      data-layout="auth"
      className="flex min-h-dvh flex-col overflow-x-clip bg-[var(--color-bg)] text-[var(--color-text)]"
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,var(--safe-top))] lg:px-8 lg:pt-4">
        <span className="flex min-w-0 items-center gap-2">
          <AquariumMark size={28} title="" />
          <span className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">Aquarium</span>
        </span>
        <LanguageSwitch />
      </header>
      <main className="flex flex-1 flex-col items-center px-4 pb-[max(1.5rem,var(--safe-bottom))] pt-4 lg:pt-16">
        <div className={`w-full min-w-0 ${wide ? "max-w-[860px]" : "max-w-[420px]"}`}>{children}</div>
        <p className="mt-6 text-center text-xs text-[var(--color-muted)]">{t("footer")}</p>
      </main>
    </div>
  );
}

/** The auth card: one bordered surface holding a screen's content. */
export function AuthCard({
  children,
  component,
  className = "",
}: {
  children: ReactNode;
  component?: string;
  className?: string;
}) {
  return (
    <section
      data-component={component}
      className={`flex min-w-0 flex-col rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 lg:p-8 ${className}`}
    >
      {children}
    </section>
  );
}

export const ILLUSTRATIONS = {
  welcome: "/brand/illustrations/signin-welcome.webp",
  lostFish: "/brand/illustrations/lost-fish.webp",
  bowl: "/brand/illustrations/bowl-needs-a-moment.webp",
} as const;

const SIZES: Record<keyof typeof ILLUSTRATIONS, [number, number]> = {
  welcome: [491, 360],
  lostFish: [503, 360],
  bowl: [411, 360],
};

/** A decorative brand illustration: 120 px tall on phones, 150 px from `lg`. */
export function AuthIllustration({
  name,
  className = "",
}: {
  name: keyof typeof ILLUSTRATIONS;
  className?: string;
}) {
  const [w, h] = SIZES[name];
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand asset, already optimised
    <img
      src={ILLUSTRATIONS[name]}
      alt=""
      aria-hidden="true"
      width={w}
      height={h}
      className={`h-[120px] w-auto max-w-full object-contain lg:h-[150px] ${className}`}
    />
  );
}
