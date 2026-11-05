"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import {
  agreedUnderstanding,
  answersPayload,
  emptyClarifyState,
  formatWhen,
  latestRound,
  roundQuestions,
  scopeView,
  type AnswerDrafts,
} from "@/components/projects/scope/clarify";
import { FocusInput } from "@/components/projects/scope/FocusInput";
import { QuestionsForm } from "@/components/projects/scope/QuestionsForm";
import { ScopeHistory } from "@/components/projects/scope/ScopeHistory";
import {
  ScopeJobFailed,
  ScopeLoadFailed,
  ScopeLoading,
  ScopeRunning,
} from "@/components/projects/scope/ScopeStatus";
import { UnderstandingCard } from "@/components/projects/scope/UnderstandingCard";
import { CARD, LINK, PRIMARY, SECONDARY } from "@/components/projects/scope/ui";
import { useClarifyState } from "@/components/projects/scope/useClarifyState";
import { useScopeActions, type ScopeActions } from "@/components/projects/scope/useScopeActions";
import type { ProjectTab, ProjectTabProps } from "@/components/projects/tabs/types";
import type { ClarifyState } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/**
 * Scope — before implementation the agent reads the brief, goal, outputs and
 * inputs and asks the owner a few clarifying questions, then writes down its
 * understanding for the owner to confirm. A soft gate: the owner can skip
 * straight to the plan at any point.
 */
export function ScopeTab({ project, canLead, onNavigate }: ProjectTabProps) {
  const summary = project.clarify;
  const [initial] = useState<ClarifyState | null>(() =>
    summary?.status === "not_started" ? emptyClarifyState(summary) : null,
  );
  const { state, loadError, apply, reload } = useClarifyState(project.slug, {
    initial,
    version: project,
  });
  const actions = useScopeActions(project.slug, apply);
  const canEdit = canLead && !project.archived;

  return (
    <div data-component="ScopeTab" className="flex flex-col gap-4">
      {state ? (
        <ScopeBody
          state={state}
          actions={actions}
          canEdit={canEdit}
          archived={project.archived}
          onNavigate={onNavigate}
        />
      ) : loadError ? (
        <ScopeLoadFailed message={loadError} onRetry={reload} />
      ) : (
        <ScopeLoading />
      )}
    </div>
  );
}

function ScopeBody({
  state,
  actions,
  canEdit,
  archived,
  onNavigate,
}: {
  state: ClarifyState;
  actions: ScopeActions;
  canEdit: boolean;
  archived: boolean;
  onNavigate: (tab: ProjectTab) => void;
}) {
  const timeLabel = useTimeLabel();
  const [drafts, setDrafts] = useState<AnswerDrafts>({});
  const [edit, setEdit] = useState<{ round: number; text: string } | null>(null);
  const [focus, setFocus] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const round = latestRound(state);
  const questions = round ? roundQuestions(state, round.round_no) : [];
  const running = state.job.status === "running";
  const view = scopeView(state);
  const readOnly = !canEdit;
  const disabled = actions.anyBusy;

  const ask = () => {
    setRefusal(null);
    actions.askQuestions(focus);
  };

  const understanding =
    round && edit?.round === round.round_no ? edit.text : (round?.understanding ?? "");
  const unsaved = answersPayload(questions, drafts).length > 0;

  const confirm = (draftPlan: boolean) => {
    if (!round) return;
    const text = understanding.trim();
    const edited = text && text !== (round.understanding ?? "").trim() ? text : undefined;
    setRefusal(null);
    actions.confirmScope(edited, draftPlan, (result) => {
      setEdit(null);
      setDrafts({});
      if (!draftPlan) return;
      if (result.plan_draft?.status === "refused") {
        setRefusal(result.plan_draft.detail || "The plan couldn't be drafted yet.");
      } else {
        onNavigate("plan");
      }
    });
  };

  const toPlan = (label: string) => (
    <button type="button" className={LINK} disabled={disabled} onClick={() => onNavigate("plan")}>
      {label}
    </button>
  );

  return (
    <>
      {state.job.status === "failed" ? (
        <ScopeJobFailed
          detail={state.job.detail}
          canRetry={canEdit}
          busy={actions.ask.busy}
          onRetry={ask}
        />
      ) : null}
      {refusal ? (
        <section
          data-component="ClarifyDraftRefused"
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-[var(--color-warn-text)]"
        >
          <span role="alert" className="min-w-0 flex-1">
            Scope confirmed, but the plan wasn&rsquo;t drafted: {refusal}
          </span>
          {toPlan("Open the plan")}
        </section>
      ) : null}

      {running ? (
        <>
          <ScopeRunning />
          <ScopeHistory state={state} />
        </>
      ) : view === "not_started" ? (
        <section data-component="ClarifyHero" className={CARD}>
          {readOnly ? (
            <p className="text-sm text-[var(--color-muted)]">
              {archived
                ? "This project is archived. The agent never asked about its scope."
                : "The agent hasn't asked about scope yet."}
            </p>
          ) : (
            <>
              <h2 className="text-base font-semibold">
                Before the agent plans, let it ask about scope
              </h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                It reads the brief, goal, outputs and inputs, then asks a few
                questions about goal, audience, success and constraints, so the
                plan starts from what you actually mean.
              </p>
              <div className="mt-3">
                <FocusInput
                  id="clarify-focus"
                  label="Anything it should focus on?"
                  value={focus}
                  onChange={setFocus}
                  disabled={disabled}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <ActionButton
                  busy={actions.ask.busy}
                  disabled={disabled}
                  pendingLabel="Asking…"
                  className={PRIMARY}
                  onClick={ask}
                >
                  Ask me questions
                </ActionButton>
                {toPlan("Skip — go to the plan")}
              </div>
              <ActionError action={actions.ask} />
            </>
          )}
        </section>
      ) : view === "open" && round ? (
        <>
          <section data-component="ClarifyRoundHeader" className={CARD}>
            <h2 className="text-base font-semibold">
              {round.round_no > 1 ? "A few follow-up questions" : "A few questions before planning"}
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {readOnly
                ? "The agent asked the owner these questions."
                : "Answer what you can and skip the rest. You can change answers until you confirm."}
              {round.focus ? ` Focus: ${round.focus}.` : ""}
            </p>
            {readOnly ? null : <div className="mt-2">{toPlan("Skip the questions — go to the plan")}</div>}
          </section>
          <QuestionsForm
            questions={questions}
            drafts={drafts}
            setDrafts={setDrafts}
            actions={actions}
            readOnly={readOnly}
          />
          <ScopeHistory state={state} excludeRound={round.round_no} title="Earlier rounds" />
        </>
      ) : view === "answered" && round ? (
        <>
          <UnderstandingCard
            round={round}
            text={understanding}
            onText={(text) => setEdit({ round: round.round_no, text })}
            focus={focus}
            onFocus={setFocus}
            actions={actions}
            readOnly={readOnly}
            confirmBlocked={unsaved ? "Save your changed answers first." : null}
            onConfirm={confirm}
          />
          {questions.length > 0 ? (
            <details data-component="ClarifyReviewAnswers" className={CARD}>
              <summary className="cursor-pointer text-sm font-semibold">
                {readOnly ? "Questions and answers" : "Review or change your answers"}
              </summary>
              <div className="mt-3">
                <QuestionsForm
                  questions={questions}
                  drafts={drafts}
                  setDrafts={setDrafts}
                  actions={actions}
                  readOnly={readOnly}
                />
              </div>
            </details>
          ) : null}
          <ScopeHistory state={state} excludeRound={round.round_no} title="Earlier rounds" />
        </>
      ) : (
        <>
          <section data-component="ClarifyConfirmed" className={CARD}>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Agreed scope</h2>
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">
                Confirmed
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {agreedUnderstanding(state) ?? "Confirmed without a written summary."}
            </p>
            {formatWhen(state.confirmed_at ?? round?.confirmed_at) ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Confirmed {timeLabel(state.confirmed_at ?? round?.confirmed_at, "date")}. The plan and
                every run follow this scope.
              </p>
            ) : null}
            {readOnly ? null : (
              <div className="mt-4 border-t border-[var(--color-border)] pt-3">
                <FocusInput
                  id="clarify-more-focus"
                  label="Has the direction changed? Tell the agent what's new"
                  value={focus}
                  onChange={setFocus}
                  disabled={disabled}
                />
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <ActionButton
                    busy={actions.ask.busy}
                    disabled={disabled}
                    pendingLabel="Asking…"
                    className={SECONDARY}
                    onClick={ask}
                  >
                    Ask more questions
                  </ActionButton>
                  {toPlan("Go to the plan")}
                </div>
                <ActionError action={actions.ask} />
              </div>
            )}
          </section>
          <ScopeHistory state={state} />
        </>
      )}
    </>
  );
}
