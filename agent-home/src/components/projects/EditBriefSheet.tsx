"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { CategoryPicker } from "@/components/projects/categories/CategoryPicker";
import { useProjectCategories } from "@/components/projects/categories/useProjectCategories";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import type { ProjectDetail, ProjectStatus } from "@/types";

/** The subset of `PATCH /{slug}` a lead edits from the brief. */
interface BriefFields {
  name: string;
  goal: string;
  description: string;
  target_audience: string;
}

const TEXT_FIELDS = ["name", "goal", "description", "target_audience"] as const;

/** The brief plus its category (null = Uncategorized). */
type BriefState = BriefFields & { category_id?: string | null };

export type BriefPatch = Partial<BriefFields> & { category_id?: string | null };

const PAUSABLE: Partial<
  Record<ProjectStatus, { to: ProjectStatus; label: string; pending: string }>
> = {
  active: { to: "paused", label: "Pause the project", pending: "Pausing…" },
  paused: { to: "active", label: "Resume the project", pending: "Resuming…" },
};

/** Only the fields that changed — the API treats every key as an assignment. */
/** `category_id` is sent only when it changed; clearing it sends `null`. */
export function briefPatch(before: BriefState, after: BriefState): BriefPatch {
  const patch: BriefPatch = {};
  for (const key of TEXT_FIELDS) {
    if (after[key].trim() !== before[key].trim()) patch[key] = after[key].trim();
  }
  if ("category_id" in after) {
    const next = after.category_id || null;
    if (next !== (before.category_id || null)) patch.category_id = next;
  }
  return patch;
}

/**
 * Edit the brief in place — name, goal, requirements, audience — plus the
 * pause/resume toggle, the one lifecycle move that isn't destructive enough
 * for the lifecycle menu. Bottom sheet like {@link AddToProjectSheet}.
 */
export function EditBriefSheet({
  project,
  onClose,
}: {
  project: ProjectDetail;
  /** Called after a successful save too — the caller refreshes. */
  onClose: () => void;
}) {
  const before: BriefState = {
    name: project.name,
    goal: project.goal ?? "",
    description: project.description ?? "",
    target_audience: project.target_audience ?? "",
    category_id: project.category_id ?? null,
  };
  const [fields, setFields] = useState<BriefState>(before);
  const categories = useProjectCategories();
  const saveAction = useProjectAction();
  const toggleAction = useProjectAction();
  const busy = saveAction.busy || toggleAction.busy;
  const [fieldErrors, setFieldErrors] = useState<Partial<BriefFields>>({});

  const slugPath = `/api/projects/${encodeURIComponent(project.slug)}`;

  // The caller refreshes on close and holds its busy state meanwhile.
  const patchRequest = (body: Record<string, unknown>) => ({
    method: "PATCH" as const,
    body,
    skipRefresh: true,
    onSuccess: () => onClose(),
  });
  // Never drop the sheet mid-write: the lock would go with it.
  const close = () => {
    if (!busy) onClose();
  };

  const save = async () => {
    const next: Partial<BriefFields> = {};
    if (!fields.goal.trim()) next.goal = "A project needs a goal sentence.";
    if (!fields.name.trim()) next.name = "A project needs a name.";
    setFieldErrors(next);
    if (Object.keys(next).length > 0) return;
    const body = briefPatch(before, fields);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    await saveAction.run(slugPath, patchRequest(body));
  };

  const toggle = PAUSABLE[project.status];

  const set = (key: (typeof TEXT_FIELDS)[number]) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const inputClass = (bad: boolean) =>
    `w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] ${
      bad ? "border-red-400" : "border-[var(--color-border)]"
    } bg-[var(--color-surface)]`;

  return (
    <div
      data-component="EditBriefSheet"
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Edit brief"
        className="mx-auto flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl border-x border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        style={{ paddingBottom: "calc(var(--safe-bottom) + 1rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Edit brief</h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-sm text-[var(--color-muted)] disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <BusyRegion busy={busy} label="Saving…">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span>Name</span>
              <input
                value={fields.name}
                onChange={(e) => set("name")(e.target.value)}
                className={inputClass(Boolean(fieldErrors.name))}
              />
              {fieldErrors.name ? (
                <span className="text-xs text-red-400">{fieldErrors.name}</span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Goal — one sentence</span>
              <input
                value={fields.goal}
                onChange={(e) => set("goal")(e.target.value)}
                className={inputClass(Boolean(fieldErrors.goal))}
              />
              {fieldErrors.goal ? (
                <span className="text-xs text-red-400">{fieldErrors.goal}</span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Requirements — what “done” looks like</span>
              <textarea
                value={fields.description}
                onChange={(e) => set("description")(e.target.value)}
                rows={5}
                className={inputClass(false)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Audience (optional)</span>
              <input
                value={fields.target_audience}
                onChange={(e) => set("target_audience")(e.target.value)}
                placeholder="the founders, my team, me"
                className={inputClass(false)}
              />
            </label>

            <CategoryPicker
              id="edit-brief-category"
              categories={categories.categories}
              value={fields.category_id ?? null}
              onChange={(id) => setFields((prev) => ({ ...prev, category_id: id }))}
              disabled={busy || categories.loading}
            />
            {categories.error ? (
              <span className="-mt-2 text-xs text-[var(--color-muted)]">
                Couldn&rsquo;t load the categories — the current one is kept.
              </span>
            ) : null}

            <ActionError action={saveAction} className="flex flex-wrap items-center gap-2 text-sm text-red-400" />
            <ActionError action={toggleAction} className="flex flex-wrap items-center gap-2 text-sm text-red-400" />

            <div className="flex items-center gap-2">
              {toggle ? (
                <ActionButton
                  busy={toggleAction.busy}
                  pendingLabel={toggle.pending}
                  disabled={busy}
                  onClick={() =>
                    void toggleAction.run(slugPath, patchRequest({ status: toggle.to }))
                  }
                  className="rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50"
                >
                  {toggle.label}
                </ActionButton>
              ) : null}
              <span className="flex-1" />
              <ActionButton
                type="submit"
                busy={saveAction.busy}
                pendingLabel="Saving…"
                disabled={busy}
                className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                Save
              </ActionButton>
            </div>
          </form>
        </BusyRegion>
      </div>
    </div>
  );
}
