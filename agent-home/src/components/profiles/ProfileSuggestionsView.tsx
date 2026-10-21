"use client";

import { useState } from "react";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { Pill } from "@/components/ui/Pill";
import { ForwardError, sendJson } from "@/components/profiles/api";
import type {
  ProfileSuggestion,
  ProfileSuggestionAdoptResponse,
  ProfileSuggestionSummary,
  Role,
} from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

export interface ProfileSuggestionsViewProps {
  role: Role;
  /** Open suggestions — at most one (§1.1), each with its evidence. */
  suggestions: ProfileSuggestion[];
  /** The capped reviewed trail, without evidence (see `ProfileSuggestionSummary`). */
  reviewed: ProfileSuggestionSummary[];
  error: string | null;
}

interface EvidenceDetail {
  top_skills?: Array<{ name: string; uses: number }>;
  orphan_goals?: Array<{ id: string; title?: string; tier?: string }>;
  current_description?: string;
}

/**
 * FG-30 §4.2 T1 — the suggestion queue.
 *
 * At most one open suggestion at a time (§1.1), rendered as a **card** not a
 * list — a list trains batch-dismissal, and a dismissal latches forever on the
 * evidence's identity, so presenting several at once would kill the good
 * suggestion along with the noise. Role and goal are both shown (§1.2), with
 * the rationale in the owner's language; the evidence is available but not
 * shouted, because the owner is being asked to accept a claim about their own
 * work and the claim must be legible without the model's arithmetic.
 *
 * Adopt and dismiss are owner-only. The Python layer is the authority; the
 * buttons are hidden for a non-owner for a clean UX, but the 403 from upstream
 * is the real gate — the BFF does not re-derive `is_owner`. Dismiss takes an
 * optional reason and warns, once and plainly, that it is permanent for that
 * evidence.
 */
export function ProfileSuggestionsView({
  role,
  suggestions,
  reviewed,
  error,
}: ProfileSuggestionsViewProps) {
  const isOwner = role === "owner";
  const open = suggestions;

  if (error) {
    return (
      <div
        data-component="SuggestionsError"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
      >
        Couldn&apos;t load suggestions ({error}).
      </div>
    );
  }

  if (open.length === 0 && reviewed.length === 0) {
    return (
      <p
        data-component="SuggestionsEmpty"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
      >
        No suggestions right now. The system proposes a new profile when your
        work clusters into a distinct sub-goal — at most once a month, and only
        when nothing is already waiting for you here.
      </p>
    );
  }

  return (
    <div data-component="ProfileSuggestionsView" className="space-y-4">
      {open.length > 0 ? (
        open.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} isOwner={isOwner} />
        ))
      ) : (
        <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          Nothing waiting for you. The next suggestion appears here when a new
          work cluster is found.
        </p>
      )}

      {reviewed.length > 0 ? (
        <ReviewedHistory reviewed={reviewed} />
      ) : null}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  isOwner,
}: {
  suggestion: ProfileSuggestion;
  isOwner: boolean;
}) {
  const [busy, setBusy] = useState<"adopt" | "dismiss" | null>(null);
  const [outcome, setOutcome] = useState<
    | { kind: "adopted"; name: string; goal: string }
    | { kind: "dismissed"; name: string }
    | null
  >(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  async function adopt() {
    setBusy("adopt");
    setFailed(null);
    try {
      const resp = await sendJson<ProfileSuggestionAdoptResponse>(
        `/api/profiles/suggestions/${encodeURIComponent(suggestion.id)}/adopt`,
        "POST",
      );
      setOutcome({ kind: "adopted", name: resp.name, goal: resp.goal });
    } catch (err) {
      setFailed(
        err instanceof ForwardError && err.status === 403
          ? "Only the owner may adopt a suggestion."
          : err instanceof Error
            ? err.message
            : "Adoption failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("dismiss");
    setFailed(null);
    try {
      const resp = await sendJson<{ ok: boolean; name: string }>(
        `/api/profiles/suggestions/${encodeURIComponent(suggestion.id)}/dismiss`,
        "POST",
        reason.trim() ? { reason: reason.trim() } : undefined,
      );
      setOutcome({ kind: "dismissed", name: resp.name });
    } catch (err) {
      setFailed(
        err instanceof ForwardError && err.status === 403
          ? "Only the owner may dismiss a suggestion."
          : err instanceof Error
            ? err.message
            : "Dismissal failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (outcome) {
    return (
      <div
        data-component="SuggestionOutcome"
        className="rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-4"
      >
        {outcome.kind === "adopted" ? (
          <>
            <p className="text-sm font-medium">
              <code className="font-mono">{outcome.name}</code> created
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              It&apos;s channel-less for now — usable from here and the CLI. When
              you&apos;re ready to give it its own bot, run{" "}
              <code className="font-mono">
                hermes profile commit-channel {outcome.name}
              </code>
              .
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Sub-goal: {outcome.goal}
            </p>
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">
            Dismissed <code className="font-mono">{outcome.name}</code>. It
            won&apos;t be proposed again on the same evidence.
          </p>
        )}
      </div>
    );
  }

  return (
    <article
      data-component="SuggestionCard"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{suggestion.proposed_role}</h2>
        <Pill tone="accent">{suggestion.proposed_name}</Pill>
      </div>
      <p className="mt-1 text-sm">
        <span className="text-[var(--color-muted)]">Sub-goal: </span>
        {suggestion.proposed_goal}
      </p>
      {suggestion.rationale ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {suggestion.rationale}
        </p>
      ) : null}

      <details className="mt-3 text-xs text-[var(--color-muted)]">
        <summary className="cursor-pointer select-none">Evidence</summary>
        <EvidenceList evidence={suggestion.evidence} />
      </details>

      {failed ? (
        <p className="mt-3 text-xs text-red-300" role="alert">
          {failed}
        </p>
      ) : null}

      {isOwner ? (
        busy === null ? (
          dismissOpen ? (
            <div className="mt-4 space-y-2" data-component="DismissForm">
              <label className="block text-xs text-[var(--color-muted)]">
                Why (optional — recorded in the audit trail)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm"
                placeholder="Not a real sub-goal, or already handled elsewhere…"
              />
              <p className="text-xs text-[var(--color-warn-text)]">
                This is permanent: a dismissed suggestion is never re-proposed on
                the same evidence.
              </p>
              <div className="flex gap-2">
                <ActionButton
                  onAction={() => dismiss()}
                  className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs active:opacity-70"
                >
                  Confirm dismiss
                </ActionButton>
                <button
                  type="button"
                  onClick={() => {
                    setDismissOpen(false);
                    setReason("");
                    setFailed(null);
                  }}
                  className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs active:opacity-70"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <ActionButton
                onAction={() => adopt()}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] active:opacity-70"
              >
                Adopt
              </ActionButton>
              <button
                type="button"
                onClick={() => void setDismissOpen(true)}
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs active:opacity-70"
              >
                Dismiss
              </button>
            </div>
          )
        ) : (
          <BusyRegion
            busy
            label={busy === "adopt" ? "Adopting" : "Dismissing"}
            className="mt-4"
          >
            <div className="flex gap-2 py-1">
              <button
                type="button"
                disabled
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] opacity-50"
              >
                {busy === "adopt" ? "Adopt" : "Confirm dismiss"}
              </button>
            </div>
          </BusyRegion>
        )
      ) : (
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Only the owner can adopt or dismiss.
        </p>
      )}
    </article>
  );
}

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const detail = evidence as unknown as EvidenceDetail;
  return (
    <dl className="mt-2 space-y-2">
      {Array.isArray(detail.top_skills) && detail.top_skills.length > 0 ? (
        <div>
          <dt className="font-medium text-[var(--color-fg)]">Skill cluster</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {detail.top_skills.map((s) => (
              <span
                key={s.name}
                className="rounded-full bg-[var(--color-surface-2)] px-2 py-1"
              >
                {s.name}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {Array.isArray(detail.orphan_goals) && detail.orphan_goals.length > 0 ? (
        <div>
          <dt className="font-medium text-[var(--color-fg)]">Unparented goals</dt>
          <dd className="mt-1">
            <ul className="list-inside list-disc">
              {detail.orphan_goals.map((g) => (
                <li key={g.id}>{g.title ?? g.id}</li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function ReviewedHistory({ reviewed }: { reviewed: ProfileSuggestionSummary[] }) {
  return (
    <section
      data-component="ReviewedHistory"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
        Reviewed
      </h3>
      <ul className="mt-2 space-y-1">
        {reviewed.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <Pill tone={s.status === "adopted" ? "success" : "muted"}>
              {s.status}
            </Pill>
            <span>{s.proposed_role}</span>
            <span className="text-[var(--color-muted)]">— {s.proposed_goal}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}