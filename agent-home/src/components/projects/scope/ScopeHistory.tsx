"use client";

import { CATEGORY_LABEL, roundQuestions } from "@/components/projects/scope/clarify";
import { CARD } from "@/components/projects/scope/ui";
import type { ClarifyState } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/** Every round's questions and answers, collapsed by round, newest first. */
export function ScopeHistory({
  state,
  excludeRound,
  title = "Questions and answers",
}: {
  state: ClarifyState;
  /** Leave out a round already shown in full above. */
  excludeRound?: number;
  title?: string;
}) {
  const timeLabel = useTimeLabel();
  const rounds = [...state.rounds]
    .filter((r) => r.round_no !== excludeRound)
    .sort((a, b) => b.round_no - a.round_no);
  if (rounds.length === 0) return null;
  return (
    <section data-component="ClarifyHistory" className={CARD}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-2 flex flex-col divide-y divide-[var(--color-border)]">
        {rounds.map((round) => {
          const questions = roundQuestions(state, round.round_no);
          const when = round.created_at ? timeLabel(round.created_at, "date") : null;
          return (
            <details key={round.round_no} data-round={round.round_no} className="py-2">
              <summary className="cursor-pointer text-sm">
                Round {round.round_no}
                <span className="text-[var(--color-muted)]">
                  {when ? ` · ${when}` : ""}
                  {` · ${questions.length} question${questions.length === 1 ? "" : "s"}`}
                  {round.focus ? ` · focus: ${round.focus}` : ""}
                </span>
              </summary>
              {questions.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  No questions — the agent had what it needed.
                </p>
              ) : (
                <dl className="mt-2 flex flex-col gap-2">
                  {questions.map((q) => (
                    <div key={q.id}>
                      <dt className="text-sm">
                        <span className="mr-1 text-xs text-[var(--color-muted)]">
                          {CATEGORY_LABEL[q.category] ?? CATEGORY_LABEL.other}:
                        </span>
                        {q.question}
                      </dt>
                      <dd
                        className={`text-sm ${
                          q.status === "answered" ? "" : "italic text-[var(--color-muted)]"
                        }`}
                      >
                        {q.status === "answered" ? q.answer : q.status === "skipped" ? "Skipped" : "Not answered"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
