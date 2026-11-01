"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { DashActionButton } from "@/components/projects/dashboard/DashActionButton";
import {
  JOURNEY_STEPS,
  journeyPhase,
  primaryBlockedReason,
  readinessLine,
  readinessProgress,
} from "@/components/projects/dashboard/journey";
import {
  dismissJourneyHint,
  journeyHintPending,
} from "@/components/projects/dashboard/journeyHint";
import type { DashAction, NextAction } from "@/components/projects/dashboard/nextAction";
import { TONE_DOT } from "@/components/projects/dashboard/tone";
import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectTab } from "@/components/projects/tabs/types";
import type { ProjectDetail } from "@/types";

const noSubscribe = () => () => {};

/** Activation when it is the next readiness gap but not the top action. */
const ACTIVATE: DashAction = {
  label: "Activate",
  pendingLabel: "Activating…",
  effect: "Sets the project to Active so runs can start.",
  intent: { kind: "activate" },
};

/** How long the "Project is active." style line stays after an action. */
export const CONFIRMATION_MS = 8000;

/**
 * The project's one place to look for "what do I click next": where it is on
 * Set up → Ready → Running → Review → Done, and the single primary button
 * (`nextAction().primary`, fired through `DashActionButton`). Readiness gaps
 * are a click away from the field that fixes them.
 */
export function JourneyBar({
  project,
  action,
  readiness,
  canLead,
  canAct,
  onNavigate,
  onReveal,
  onChangeRequest,
}: {
  project: ProjectDetail;
  action: NextAction;
  readiness: ReadinessItem[];
  /** Owner, lead or box admin. */
  canLead: boolean;
  /** `canLead` or a plain member — who may make judgement calls. */
  canAct: boolean;
  onNavigate: (tab: ProjectTab) => void;
  /** Open a readiness item's tab and scroll to + highlight its field. */
  onReveal: (item: ReadinessItem) => void;
  onChangeRequest: (initialText?: string) => void;
}) {
  const phase = journeyPhase(project, readiness, action);
  const current = JOURNEY_STEPS.findIndex((step) => step.phase === phase);
  const closed = project.archived || project.status === "done";
  const guide = closed ? null : readinessLine(readiness);
  const { next } = readinessProgress(readiness);
  const blocked = primaryBlockedReason(action.primary.intent, { canLead, canAct });

  const [confirmation, setConfirmation] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConfirmed = useCallback((text: string) => {
    setConfirmation(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirmation(null), CONFIRMATION_MS);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // localStorage is not there during the server render: false until hydrated.
  const pending = useSyncExternalStore(
    noSubscribe,
    () => journeyHintPending(project.slug),
    () => false,
  );
  const [dismissed, setDismissed] = useState(false);
  const hint = pending && !dismissed;

  // A readiness fix the button navigates to also reveals its field.
  const navigate = useCallback(
    (tab: ProjectTab) => {
      const key = action.key.startsWith("readiness:") ? action.key.slice(10) : null;
      const item = key ? readiness.find((r) => r.key === key && r.tab === tab) : undefined;
      if (item) onReveal(item);
      else onNavigate(tab);
    },
    [action.key, onNavigate, onReveal, readiness],
  );

  return (
    <section
      id="journey-bar"
      data-component="JourneyBar"
      data-phase={phase}
      data-state={action.state}
      data-tone={action.tone}
      data-needs-person={action.needsPerson ? "true" : undefined}
      aria-label="Project journey"
      className="rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-2.5 shadow-lg"
    >
      <ol data-component="JourneySteps" className="flex items-center gap-0.5 text-[11px] sm:gap-1 sm:text-xs">
        {JOURNEY_STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li
              key={step.phase}
              data-step={step.phase}
              data-step-state={state}
              aria-current={state === "current" ? "step" : undefined}
              className={`flex items-center gap-1 ${state === "current" ? "shrink-0" : "min-w-0 flex-1"}`}
            >
              <span
                className={`min-w-0 truncate rounded-full px-1.5 py-0.5 sm:px-2 ${
                  state === "current"
                    ? "bg-[var(--color-accent)] font-semibold text-[var(--color-accent-fg)]"
                    : state === "done"
                      ? "text-[var(--color-muted)]"
                      : "text-[var(--color-muted)] opacity-60"
                }`}
              >
                {state === "done" ? "✓ " : ""}
                {step.label}
              </span>
              {i < JOURNEY_STEPS.length - 1 ? (
                <span aria-hidden className="hidden text-[var(--color-muted)] opacity-50 sm:inline">
                  →
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2 text-sm font-semibold leading-snug">
            <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[action.tone]}`} />
            <span data-component="JourneyHeadline">{action.headline}</span>
          </p>
          <p className="hidden text-xs text-[var(--color-muted)] sm:block">{action.why}</p>
          <p data-component="NextActionEffect" className="hidden text-xs text-[var(--color-muted)] sm:block">
            {action.primary.effect}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span id="journey-primary" data-component="JourneyPrimary" className="inline-flex rounded-xl">
            <DashActionButton
              key={action.key}
              slug={project.slug}
              action={action.primary}
              variant="primary"
              onNavigate={navigate}
              onChangeRequest={onChangeRequest}
              disabled={blocked !== null}
              onConfirmed={onConfirmed}
            />
          </span>
          {action.secondary ? (
            <span className="hidden sm:inline-flex">
              <DashActionButton
                slug={project.slug}
                action={action.secondary}
                variant="row"
                onNavigate={onNavigate}
                onChangeRequest={onChangeRequest}
                disabled={primaryBlockedReason(action.secondary.intent, { canLead, canAct }) !== null}
              />
            </span>
          ) : null}
        </div>
      </div>

      {blocked ? (
        <p data-component="JourneyBlockedReason" className="mt-1 text-xs text-[var(--color-warn-text)]">
          {blocked}
        </p>
      ) : null}
      {confirmation ? (
        <p role="status" data-component="JourneyConfirmation" className="mt-1 text-xs text-emerald-400">
          {confirmation}
        </p>
      ) : null}
      {guide && next ? (
        <button
          type="button"
          data-component="JourneyReadiness"
          onClick={() => onReveal(next)}
          className="mt-1 text-left text-xs text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          {guide} →
        </button>
      ) : null}
      {next?.key === "status" && action.primary.intent.kind !== "activate" && !closed ? (
        <span className="mt-1 inline-flex">
          <DashActionButton
            slug={project.slug}
            action={ACTIVATE}
            variant="row"
            onNavigate={onNavigate}
            onChangeRequest={onChangeRequest}
            disabled={!canLead}
            onConfirmed={onConfirmed}
          />
        </span>
      ) : null}
      {hint ? (
        <div
          data-component="JourneyHint"
          role="note"
          className="mt-2 flex items-start gap-2 rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-xs"
        >
          <p className="min-w-0 flex-1">
            <b>New here?</b> This bar always shows where the project is and the
            one button to press next. It stays at the top while you scroll.
          </p>
          <button
            type="button"
            onClick={() => {
              dismissJourneyHint();
              setDismissed(true);
            }}
            className="shrink-0 font-medium text-[var(--color-accent)]"
          >
            Got it
          </button>
        </div>
      ) : null}
    </section>
  );
}
