"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { fallbackNote, lastHeardAt, NO_REASONING, useNow } from "@/components/projects/live/LiveStatusBar";
import { elapsedLabel, type LiveTask } from "@/components/projects/live/liveState";
import { useCardActivity } from "@/components/projects/useCardActivity";
import { useCardLive } from "@/components/projects/useCardLive";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import type { ProjectCardDetail } from "@/types";

/** Within this many pixels of the bottom, the output keeps following new lines. */
export const FOLLOW_SLACK_PX = 24;

/**
 * Task mode's "now running" card: which card is working, for how long, and
 * its output as it arrives — the same card activity and card row streams the
 * Project-mode live bar uses (Task mode hides the bar's own rows, so each
 * card is streamed once). Read-only: stopping stays on the live bar.
 */
export function TaskLiveCard({ slug, task }: { slug: string; task: LiveTask }) {
  const now = useNow();
  const timeLabel = useTimeLabel();
  const activity = useCardActivity(slug, task.id, true);
  const [card, setCard] = useState<ProjectCardDetail | null>(null);
  useCardLive(slug, task.id, "running", setCard);
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    const el = outputRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [activity.reasoning, activity.tools, card, expanded]);

  const heard = lastHeardAt(activity.lastAt, card, task.startedAt);
  const outputId = `task-live-output-${task.id}`;
  const step =
    task.stepIndex != null && task.stepTotal != null ? `Step ${task.stepIndex} of ${task.stepTotal}` : null;
  const meta = [
    task.profile ? `worker on ${task.profile}` : null,
    task.startedAt != null ? `started ${timeLabel(task.startedAt, "dateTime")}` : null,
    task.startedAt != null && now != null ? `running ${elapsedLabel(now - task.startedAt)}` : null,
    heard != null && now != null ? `last update ${elapsedLabel(Math.max(0, now - heard))} ago` : null,
  ].filter(Boolean);
  const fallback = fallbackNote(card);
  const streaming = !activity.ended;

  return (
    <section
      data-component="TaskLiveCard"
      data-task-id={task.id}
      aria-label={`Now running: ${task.title}`}
      className="rounded-2xl border border-sky-500/40 bg-sky-500/5 p-3"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1.5 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-400">
            Now running{step ? ` · ${step}` : ""}
          </p>
          <h3 className="break-words text-sm font-semibold">{task.title}</h3>
          <p data-component="TaskLiveMeta" className="text-xs text-[var(--color-muted)]">
            {meta.join(" · ")}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={outputId}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
        >
          {expanded ? "Hide output" : "Show output"}
        </button>
      </div>
      {expanded ? (
        <div
          id={outputId}
          ref={outputRef}
          role="log"
          aria-live="polite"
          aria-label="Card output"
          data-component="TaskLiveOutput"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
          }}
          className="mt-2 max-h-56 overflow-y-auto overscroll-contain rounded-xl bg-[var(--color-surface-2)] p-2.5 text-xs leading-relaxed sm:max-h-80"
        >
          {activity.reasoning ? (
            <p data-output="reasoning" className="whitespace-pre-wrap break-words">
              {activity.reasoning}
              {streaming ? (
                <span aria-hidden className="ml-0.5 animate-pulse text-[var(--color-accent)]">
                  ▍
                </span>
              ) : null}
            </p>
          ) : (
            <p data-output="empty" className="text-[var(--color-muted)]">
              {fallback ?? (activity.unavailable ? NO_REASONING : "Waiting for the agent's first update…")}
            </p>
          )}
          {activity.tools.length > 0 ? (
            <ul data-output="tools" className="mt-2 flex flex-col gap-1">
              {activity.tools.map((t, i) => (
                <li key={`${t.id}-${i}`} data-tool={t.done ? "done" : "running"} className="flex items-center gap-1.5">
                  {t.done ? (
                    <span aria-hidden className="text-emerald-500">✓</span>
                  ) : (
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-[var(--color-accent)] border-r-transparent"
                    />
                  )}
                  <code className="break-all">{t.name}</code>
                  <span className="text-[var(--color-muted)]">{t.done ? "done" : "running…"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1.5 text-right">
        <Link
          href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}`}
          className="text-xs text-[var(--color-accent)]"
        >
          Open card ›
        </Link>
      </div>
    </section>
  );
}
