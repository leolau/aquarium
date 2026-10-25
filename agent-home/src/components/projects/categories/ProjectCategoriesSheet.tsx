"use client";

import { useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import {
  CATEGORY_COLORS,
  CategoryDot,
} from "@/components/projects/categories/CategoryPicker";
import {
  PROJECT_CATEGORIES_PATH,
  useProjectCategories,
} from "@/components/projects/categories/useProjectCategories";
import { useProjectAction, type ActionResult } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { ProjectCategory } from "@/types";

export interface ProjectCategoriesSheetProps {
  /** The current categories, in column order. */
  categories: ProjectCategory[];
  /** Close without (further) changes. Never called mid-write. */
  onClose: () => void;
  /** Called after every successful create/rename/delete with the fresh list. */
  onChanged: (next: ProjectCategory[]) => void;
}

export const CATEGORY_NAME_MAX = 40;

interface Write {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}

type WriteAnswer = Partial<ProjectCategory> & {
  deleted?: string;
  uncategorized?: number;
  detail?: unknown;
};

const categoryPath = (id: string) => `${PROJECT_CATEGORIES_PATH}/${encodeURIComponent(id)}`;

/** Client-side name check; the server still has the last word (409 / 422). */
export function categoryNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A category needs a name.";
  if (trimmed.length > CATEGORY_NAME_MAX) {
    return `Keep it to ${CATEGORY_NAME_MAX} characters or fewer.`;
  }
  return null;
}

/** The refusals this sheet can say better than the generic mapping. */
function refusalHint(result: ActionResult<WriteAnswer>): string | null {
  if (result.status === 409) return "A category with that name already exists.";
  if (result.status === 422) {
    const detail = result.data?.detail;
    return typeof detail === "string" && detail.trim()
      ? detail.trim()
      : `A category name is 1–${CATEGORY_NAME_MAX} characters.`;
  }
  return null;
}

export function projectsWillMove(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"} will move to Uncategorized.`;
}

/**
 * The writes that put `list` into `next`'s order: each category takes the
 * position of its new index (counted from the lowest position in use), and
 * only the ones whose position actually changes are sent.
 */
export function reorderWrites(
  list: readonly ProjectCategory[],
  next: readonly ProjectCategory[],
): Write[] {
  const base = list.length > 0 ? Math.min(...list.map((c) => c.position)) : 0;
  return next.flatMap((category, index) =>
    category.position === base + index
      ? []
      : [{ path: categoryPath(category.id), method: "PATCH" as const, body: { position: base + index } }],
  );
}

function Swatches({
  value,
  onPick,
  disabled,
  allowNone = false,
}: {
  value: string | null;
  onPick: (color: string | null) => void;
  disabled?: boolean;
  allowNone?: boolean;
}) {
  const options: { value: string | null; label: string }[] = [
    ...(allowNone ? [{ value: null, label: "No colour" }] : []),
    ...CATEGORY_COLORS,
  ];
  return (
    <div role="group" aria-label="Colour" className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = (value ?? null) === option.value;
        return (
          <button
            key={option.label}
            type="button"
            aria-label={option.label}
            aria-pressed={selected}
            title={option.label}
            disabled={disabled}
            onClick={() => onPick(option.value)}
            className={`flex h-7 w-7 items-center justify-center rounded-full border-2 disabled:opacity-50 ${
              selected ? "border-[var(--color-fg)]" : "border-transparent"
            }`}
          >
            <CategoryDot color={option.value} className="h-5 w-5" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Bottom sheet to add, rename, recolour, reorder and delete project
 * categories. Every write goes through one `useProjectAction` lock; after
 * each success the list is re-read and handed to `onChanged`. The sheet
 * cannot be closed while a write (or the re-read after it) is in flight.
 */
export function ProjectCategoriesSheet({
  categories,
  onClose,
  onChanged,
}: ProjectCategoriesSheetProps) {
  const cats = useProjectCategories({ initial: categories });
  const write = useProjectAction<WriteAnswer>();
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [op, setOp] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(CATEGORY_COLORS[0].value);
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProjectCategory | null>(null);

  const busy = saving || write.busy || cats.loading;
  const list = cats.categories;

  const close = () => {
    if (!busy) onClose();
  };

  const refreshList = async () => {
    const fresh = await cats.reload();
    if (fresh) onChanged(fresh);
  };

  /** Send `writes` in order (stopping at the first refusal), then re-read. */
  const commit = async (name: string, writes: Write[]): Promise<boolean> => {
    if (lock.current || writes.length === 0) return false;
    lock.current = true;
    setSaving(true);
    setOp(name);
    setHint(null);
    try {
      for (const w of writes) {
        const res = await write.run(w.path, {
          method: w.method,
          body: w.body,
          skipRefresh: true,
        });
        if (!res) return false;
        if (!res.ok) {
          setHint(refusalHint(res));
          return false;
        }
      }
      await refreshList();
      return true;
    } finally {
      lock.current = false;
      setSaving(false);
      setOp(null);
    }
  };

  // Retry re-sends the failed write with its key, then re-reads like a commit.
  const writeError = {
    error: hint ?? write.error,
    busy,
    retry: async () => {
      if (lock.current) return null;
      lock.current = true;
      setSaving(true);
      try {
        const res = await write.retry();
        if (res?.ok) {
          setHint(null);
          await refreshList();
        } else if (res) {
          setHint(refusalHint(res));
        }
        return res;
      } finally {
        lock.current = false;
        setSaving(false);
      }
    },
  };
  const readError = { error: cats.error, busy, retry: refreshList };

  const add = async () => {
    const problem = categoryNameError(newName);
    setNameError(problem);
    if (problem) return;
    const ok = await commit("add", [
      { path: PROJECT_CATEGORIES_PATH, method: "POST", body: { name: newName.trim(), color: newColor } },
    ]);
    if (ok) setNewName("");
  };

  const rename = async (category: ProjectCategory, name: string) => {
    const problem = categoryNameError(name);
    setRenameError(problem);
    if (problem) return;
    if (name.trim() === category.name) {
      setRenaming(null);
      return;
    }
    const ok = await commit(`rename:${category.id}`, [
      { path: categoryPath(category.id), method: "PATCH", body: { name: name.trim() } },
    ]);
    if (ok) setRenaming(null);
  };

  const recolour = async (category: ProjectCategory, color: string | null) => {
    if ((category.color ?? null) === color) {
      setPaletteFor(null);
      return;
    }
    const ok = await commit(`color:${category.id}`, [
      { path: categoryPath(category.id), method: "PATCH", body: { color } },
    ]);
    if (ok) setPaletteFor(null);
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    void commit(`move:${list[index].id}`, reorderWrites(list, next));
  };

  const remove = async (category: ProjectCategory) => {
    await commit(`delete:${category.id}`, [{ path: categoryPath(category.id), method: "DELETE" }]);
    setConfirmDelete(null);
  };

  const smallButton =
    "rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40";
  const inputClass = (bad: boolean) =>
    `w-full min-w-0 rounded-xl border px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] ${
      bad ? "border-red-400" : "border-[var(--color-border)]"
    } bg-[var(--color-surface)]`;

  return (
    <div
      data-component="ProjectCategoriesSheet"
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Project categories"
        className="mx-auto flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl border-x border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        style={{ paddingBottom: "calc(var(--safe-bottom) + 1rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Categories</h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-sm text-[var(--color-muted)] disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <BusyRegion busy={busy} label={op ? "Saving…" : "Loading…"}>
          <div className="flex flex-col gap-3">
            {list.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                No categories yet — add one below. Projects without a category
                show under Uncategorized.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {list.map((category, index) => {
                  const isRenaming = renaming?.id === category.id;
                  return (
                    <li
                      key={category.id}
                      data-category-id={category.id}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={`Change colour of ${category.name}`}
                          aria-expanded={paletteFor === category.id}
                          disabled={busy}
                          onClick={() =>
                            setPaletteFor((prev) => (prev === category.id ? null : category.id))
                          }
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
                        >
                          <CategoryDot color={category.color} className="h-3.5 w-3.5" />
                        </button>
                        {isRenaming ? (
                          <form
                            className="flex min-w-0 flex-1 items-center gap-1.5"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void rename(category, renaming.name);
                            }}
                          >
                            <input
                              autoFocus
                              aria-label={`New name for ${category.name}`}
                              value={renaming.name}
                              maxLength={CATEGORY_NAME_MAX + 10}
                              onChange={(e) => setRenaming({ id: category.id, name: e.target.value })}
                              className={inputClass(Boolean(renameError))}
                            />
                            <ActionButton
                              type="submit"
                              busy={busy && op === `rename:${category.id}`}
                              pendingLabel="Saving…"
                              disabled={busy}
                              className={smallButton}
                            >
                              Save
                            </ActionButton>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setRenaming(null);
                                setRenameError(null);
                              }}
                              className={smallButton}
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate text-sm">{category.name}</span>
                            <span className="shrink-0 text-xs text-[var(--color-muted)]">
                              {category.project_count}{" "}
                              {category.project_count === 1 ? "project" : "projects"}
                            </span>
                          </>
                        )}
                      </div>
                      {isRenaming && renameError ? (
                        <span className="text-xs text-red-400">{renameError}</span>
                      ) : null}
                      {paletteFor === category.id ? (
                        <Swatches
                          allowNone
                          value={category.color}
                          disabled={busy}
                          onPick={(color) => void recolour(category, color)}
                        />
                      ) : null}
                      {isRenaming ? null : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            aria-label={`Move ${category.name} up`}
                            disabled={busy || index === 0}
                            onClick={() => move(index, -1)}
                            className={smallButton}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${category.name} down`}
                            disabled={busy || index === list.length - 1}
                            onClick={() => move(index, 1)}
                            className={smallButton}
                          >
                            ↓
                          </button>
                          <span className="flex-1" />
                          <button
                            type="button"
                            aria-label={`Rename ${category.name}`}
                            disabled={busy}
                            onClick={() => {
                              setRenameError(null);
                              setRenaming({ id: category.id, name: category.name });
                            }}
                            className={smallButton}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${category.name}`}
                            disabled={busy}
                            onClick={() => setConfirmDelete(category)}
                            className={`${smallButton} text-red-400`}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <ActionError action={writeError} className="flex flex-wrap items-center gap-2 text-sm text-red-400" />
            <ActionError action={readError} className="flex flex-wrap items-center gap-2 text-sm text-red-400" />

            <form
              data-component="AddCategoryForm"
              className="flex flex-col gap-2 rounded-xl border border-dashed border-[var(--color-border)] p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                <span>New category</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Sales"
                  maxLength={CATEGORY_NAME_MAX + 10}
                  className={inputClass(Boolean(nameError))}
                />
                {nameError ? <span className="text-xs text-red-400">{nameError}</span> : null}
              </label>
              <Swatches value={newColor} onPick={setNewColor} disabled={busy} />
              <ActionButton
                type="submit"
                busy={busy && op === "add"}
                pendingLabel="Adding…"
                disabled={busy}
                className="self-end rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                Add category
              </ActionButton>
            </form>
          </div>
        </BusyRegion>
      </div>

      {confirmDelete ? (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            title={`Delete “${confirmDelete.name}”?`}
            body={projectsWillMove(confirmDelete.project_count)}
            confirmLabel="Delete category"
            busy={busy}
            onConfirm={() => remove(confirmDelete)}
            onCancel={() => {
              if (!busy) setConfirmDelete(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
