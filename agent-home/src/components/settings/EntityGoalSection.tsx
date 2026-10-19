"use client";

import { useState } from "react";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { Spinner } from "@/components/ui/Spinner";
import type { EntityGoal, EntityGoalResponse } from "@/types";
import { useT } from "@/i18n";

/**
 * The entity goal — the one goal every sub-goal ladders into.
 *
 * It lives in settings rather than on the goals surface because it is not a
 * task: it is what the system is *for*, it changes a few times a year, and it
 * is the one goal whose text is in every session's system prompt.
 *
 * Two things this section must be honest about, because both are surprising:
 *
 * * An edit takes effect in the **next** session. A conversation already
 *   running keeps the prompt it was cached with — that is what keeps the cache
 *   intact, so the UI says so instead of implying the change is live.
 * * A new install already has a goal here (a placeholder asking to be
 *   replaced), so nobody meets an empty system with no explanation of what
 *   belongs in the box.
 *
 * The goal arrives as a prop from the server-rendered page rather than from an
 * effect: the settings page already resolves the principal per request, so
 * fetching again in the browser would only add a frame of empty boxes.
 */
export function EntityGoalSection({
  goal,
  readOnly = false,
}: {
  goal: EntityGoal | null;
  readOnly?: boolean;
}) {
  const tSettings = useT("settings");
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const available = goal !== null;

  async function save() {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/goals/entity", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed, description }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? "Could not save the goal.");
      }
      const body = (await res.json()) as EntityGoalResponse;
      if (body.goal) {
        setTitle(body.goal.title);
        setDescription(body.goal.description);
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the goal.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-component="EntityGoalSection" data-section="entity-goal">
      <h2 className="text-sm font-semibold">{tSettings("entityGoal")}</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        What this system exists to achieve. Every profile&apos;s sub-goal ladders
        into it, and it is published into each profile so they can see it.
        Changes apply to new conversations — one already running keeps the
        instructions it started with.
      </p>

      <BusyRegion busy={saving} label="Saving the entity goal…">
        {!available ? (
          <p className="text-xs text-[var(--color-muted)]">
            The goal registry is not configured on this install, so there is no
            entity goal to edit yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={title}
              disabled={readOnly}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The outcome everything else serves…"
              maxLength={200}
              aria-label="Entity goal"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
            <textarea
              value={description}
              disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional: what reaching it looks like."
              rows={3}
              aria-label="Entity goal detail"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
            {readOnly ? (
              <p className="text-xs text-[var(--color-muted)]">
                Only the owner can change the entity goal.
              </p>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !title.trim()}
                  className="shrink-0 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60"
                >
                  {saving ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner />
                      Saving…
                    </span>
                  ) : (
                    "Save goal"
                  )}
                </button>
                {saved ? (
                  <span className="text-xs text-[var(--color-muted)]">
                    Saved. New conversations will see it.
                  </span>
                ) : null}
              </div>
            )}
            {error ? (
              <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </BusyRegion>
    </section>
  );
}
