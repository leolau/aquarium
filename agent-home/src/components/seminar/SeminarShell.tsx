import type { ReactNode } from "react";

import { SEMINAR_TITLE } from "@/components/seminar/content";

/**
 * The public seminar frame (Figma "survey", 23:2515): the AI&I mark and the
 * "AI&I Seminar · 講座問卷 Survey" line, the seminar title in both languages,
 * and one 640px column. Deliberately its own brand and not `MobileShell`:
 * attendees have no account, so there is no Aquarium chrome, Back or launcher.
 */
export function SeminarShell({ children }: { children: ReactNode }) {
  return (
    <main
      data-component="SeminarShell"
      className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 px-4 pb-12 pt-[max(1.5rem,env(safe-area-inset-top))] text-[var(--color-text)] md:pt-12"
    >
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no optimiser needed */}
          <img
            src="/seminar/ai-and-i-logo.jpg"
            alt="AI&I"
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-[var(--radius-lg)] object-cover"
          />
          <p className="text-sm text-[var(--color-muted)]">
            AI&amp;I Seminar <span aria-hidden="true">·</span> 講座問卷 Survey
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold leading-tight md:text-3xl">{SEMINAR_TITLE.zh}</h1>
          <p className="text-lg font-semibold text-[var(--color-muted)]">{SEMINAR_TITLE.en}</p>
        </div>
      </header>
      {children}
    </main>
  );
}

/** A message card such as "thank you" or "link not valid" (Figma survey states). */
export function SeminarNotice({
  component,
  title,
  children,
}: {
  component: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-component={component}
      className="flex flex-col gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm leading-relaxed md:p-6"
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-2 text-[var(--color-muted)]">{children}</div>
    </section>
  );
}

/** Shown once the answers are in; the slides arrive on WhatsApp. */
export function SurveyThanks() {
  return (
    <SeminarNotice component="SurveyThanks" title="多謝您完成問卷！Thank you for completing the survey!">
      <p>講座簡報已經在 WhatsApp 傳送給您，請查看您與我們的對話。</p>
      <p>
        We&apos;ve sent the presentation slides to you on WhatsApp — please check
        your chat with us.
      </p>
    </SeminarNotice>
  );
}

/** The link is unknown or a newer link has replaced it. */
export function SurveyLinkInvalid() {
  return (
    <SeminarNotice
      component="SurveyLinkInvalid"
      title="此問卷連結無效 This survey link is not valid"
    >
      <p>
        此問卷連結無效或已被更新的連結取代。請在 WhatsApp 再次向我們發送「I want to do the
        survey and get the presentation link.」以取得新連結。
      </p>
      <p>
        This link is not valid, or a newer link has replaced it. Send us &ldquo;I want to
        do the survey and get the presentation link.&rdquo; on WhatsApp again for a new one.
      </p>
    </SeminarNotice>
  );
}
