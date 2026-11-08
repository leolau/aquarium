"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { unblockPath } from "@/components/projects/CardActions";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { cardMoves, cardPatch } from "@/components/projects/cardMoves";
import { BusyRegion } from "@/components/ui/BusyRegion";
import type { ProjectCardDetail } from "@/types";

/**
 * The hand edits a member may make to a card (§10): title, brief, which
 * project profile works it, and the column it sits in. Every change is one
 * `PATCH /api/projects/{slug}/cards/{id}`; the backend refuses moves the
 * dispatcher owns and names why. On a blocked card (`canRerun`) **Save &
 * re-run** saves the edit and, only once that landed, unblocks the card
 * (with any answer typed above) so the next worker starts from the revised
 * brief.
 */
export function CardEditor({
  slug,
  card,
  profiles,
  canRerun = false,
  rerunAnswer = "",
  onUpdated,
}: {
  slug: string;
  card: ProjectCardDetail;
  /** The project's profiles — the only valid assignees. */
  profiles: string[];
  /** Blocked and not waiting on an approval: offer Save & re-run. */
  canRerun?: boolean;
  /** What the person typed in "Answer the agent"; sent along on re-run. */
  rerunAnswer?: string;
  /** The card as the server returned it after Save & re-run. */
  onUpdated?: (card: ProjectCardDetail) => void;
}) {
  const before = {
    title: card.title,
    body: card.body ?? "",
    assignee: card.assignee ?? "",
  };
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState(before);
  const action = useProjectAction<ProjectCardDetail>();
  const busy = action.busy;
  const [moving, setMoving] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);

  const patch = (
    body: Record<string, unknown>,
    onSaved?: () => void,
  ) =>
    action.run(
      `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(card.id)}`,
      { method: "PATCH", body, onSuccess: onSaved },
    );

  const save = async () => {
    if (!fields.title.trim()) {
      setInvalid("A card needs a title.");
      return;
    }
    setInvalid(null);
    const body = cardPatch(before, fields);
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setMoving(false);
    await patch(body, () => setEditing(false));
  };

  const saveAndRerun = async () => {
    if (action.busy) return;
    if (!fields.title.trim()) {
      setInvalid("A card needs a title.");
      return;
    }
    setInvalid(null);
    setMoving(false);
    const body = cardPatch(before, fields);
    if (Object.keys(body).length > 0) {
      const saved = await patch(body);
      if (!saved?.ok) return;
    }
    const reason = rerunAnswer.trim();
    await action.run(unblockPath(slug, card.id), {
      body: reason ? { reason } : {},
      onSuccess: (fresh) => {
        setEditing(false);
        onUpdated?.(fresh);
      },
    });
  };

  const moves = cardMoves(card.status);
  const assignees = Array.from(
    new Set([...(card.assignee ? [card.assignee] : []), ...profiles]),
  );

  const inputClass =
    "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";
  const buttonClass =
    "rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-40";

  return (
    <div data-component="CardEditor" className="mt-3 flex flex-col gap-2">
      <BusyRegion busy={busy} label="Saving…">
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setRerunning(false);
              void save();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">Title</span>
              <input
                value={fields.title}
                onChange={(e) =>
                  setFields((prev) => ({ ...prev, title: e.target.value }))
                }
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">Brief</span>
              <textarea
                value={fields.body}
                onChange={(e) =>
                  setFields((prev) => ({ ...prev, body: e.target.value }))
                }
                rows={5}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">
                Worked by
              </span>
              <select
                value={fields.assignee}
                onChange={(e) =>
                  setFields((prev) => ({ ...prev, assignee: e.target.value }))
                }
                disabled={card.status === "running"}
                className={inputClass}
              >
                <option value="">unassigned</option>
                {assignees.map((profile) => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
              {card.status === "running" ? (
                <span className="text-xs text-[var(--color-muted)]">
                  Stop or wait for the worker before reassigning.
                </span>
              ) : null}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFields(before);
                  setInvalid(null);
                  action.clearError();
                  setEditing(false);
                }}
                className={buttonClass}
              >
                Cancel
              </button>
              <span className="flex-1" />
              <ActionButton
                type="submit"
                busy={busy && !rerunning}
                disabled={busy}
                pendingLabel="Saving…"
                className={
                  canRerun
                    ? buttonClass
                    : "rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
                }
              >
                Save
              </ActionButton>
              {canRerun ? (
                <ActionButton
                  busy={busy && rerunning}
                  disabled={busy}
                  pendingLabel="Re-running…"
                  onClick={() => {
                    setRerunning(true);
                    void saveAndRerun();
                  }}
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
                >
                  Save &amp; re-run
                </ActionButton>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={busy}
              className={buttonClass}
            >
              Edit card
            </button>
            {moves.length > 0 ? (
              <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                <span>Move</span>
                <select
                  aria-label="Move card"
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    const to = e.target.value;
                    if (!to || action.busy) return;
                    setMoving(true);
                    void patch({ status: to });
                  }}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
                >
                  <option value="">to…</option>
                  {moves.map((move) => (
                    <option key={move.to} value={move.to}>
                      {move.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {busy && moving ? (
              <span role="status" className="text-xs text-[var(--color-muted)]">
                Moving…
              </span>
            ) : null}
          </div>
        )}
      </BusyRegion>
      {invalid ? (
        <p className="text-xs text-[var(--color-danger)]" role="alert">
          {invalid}
        </p>
      ) : null}
      <ActionError action={action} className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]" />
    </div>
  );
}
