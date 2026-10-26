"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { sortCategories } from "@/components/projects/categories/useProjectCategories";
import { UNCATEGORIZED_FILTER } from "@/components/projects/filters";
import {
  newIdempotencyKey,
  sendProjectAction,
} from "@/components/projects/useProjectAction";
import { useAction } from "@/lib/use-action";
import type { ProjectCategory, ProjectListItem } from "@/types";

type BulkKind = "category" | "archive" | "restore";

interface BulkResult {
  kind: BulkKind;
  /** For "category": the category the projects moved to. */
  label?: string;
  done: number;
  failed: { slug: string; name: string; error: string }[];
}

const DONE_VERB: Record<BulkKind, string> = {
  category: "Moved",
  archive: "Archived",
  restore: "Restored",
};

const FAIL_VERB: Record<BulkKind, string> = {
  category: "move",
  archive: "archive",
  restore: "restore",
};

function plural(n: number): string {
  return `${n} ${n === 1 ? "project" : "projects"}`;
}

/**
 * The list's bulk actions on the ticked projects: set their category,
 * archive them, or restore archived ones. Each project goes through its own
 * existing endpoint (`PATCH /api/projects/{slug}` `{category_id}`,
 * `POST …/archive`, `POST …/restore`) one at a time, so every project keeps
 * its own permission check and audit note, and one refusal (e.g. a run still
 * open) is reported by name without stopping the rest.
 */
export function ProjectsBulkBar({
  selected,
  pageItems,
  categories,
  onSelectPage,
  onClear,
  onDone,
}: {
  /** The ticked projects (on any page). */
  selected: ProjectListItem[];
  /** The projects on the page being shown. */
  pageItems: ProjectListItem[];
  categories: readonly ProjectCategory[];
  onSelectPage: (select: boolean) => void;
  onClear: () => void;
  /** After a bulk action: the slugs that went through. */
  onDone: (succeeded: string[]) => void;
}) {
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);

  const selectedSlugs = new Set(selected.map((p) => p.slug));
  const pageAll =
    pageItems.length > 0 && pageItems.every((p) => selectedSlugs.has(p.slug));
  const toArchive = selected.filter((p) => !p.archived);
  const toRestore = selected.filter((p) => p.archived);
  const ordered = sortCategories(categories);

  async function apply(
    kind: BulkKind,
    targets: ProjectListItem[],
    label?: string,
  ): Promise<void> {
    setResult(null);
    setProgress({ done: 0, total: targets.length });
    const succeeded: string[] = [];
    const failed: BulkResult["failed"] = [];
    const categoryId = target === UNCATEGORIZED_FILTER ? null : target;
    for (const [i, project] of targets.entries()) {
      const base = `/api/projects/${encodeURIComponent(project.slug)}`;
      const res =
        kind === "category"
          ? await sendProjectAction(base, newIdempotencyKey(), {
              method: "PATCH",
              body: { category_id: categoryId },
            })
          : await sendProjectAction(`${base}/${kind}`, newIdempotencyKey(), {
              method: "POST",
              body: {},
            });
      if (res.ok) succeeded.push(project.slug);
      else
        failed.push({
          slug: project.slug,
          name: project.name,
          error: res.error ?? "That did not go through.",
        });
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    setConfirming(false);
    setResult({ kind, label, done: succeeded.length, failed });
    onDone(succeeded);
  }

  const { run, pending } = useAction(apply);

  const moveTargets = selected.filter(
    (p) => (p.category_id ?? UNCATEGORIZED_FILTER) !== target,
  );
  const targetName =
    target === UNCATEGORIZED_FILTER
      ? "Uncategorized"
      : ordered.find((c) => c.id === target)?.name;
  const working = progress
    ? `Working… ${progress.done} of ${progress.total}`
    : "Working…";

  return (
    <div data-component="ProjectsBulkBar" className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={pageAll}
            disabled={pending || pageItems.length === 0}
            onChange={() => onSelectPage(!pageAll)}
            className="h-4 w-4"
          />
          Select all on this page
        </label>
        {selected.length > 0 ? (
          <>
            <span
              data-component="ProjectsSelectedCount"
              className="font-medium text-[var(--color-fg)]"
            >
              {selected.length} selected
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={onClear}
              className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)] disabled:opacity-50"
            >
              Unselect all
            </button>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5">
                <span className="sr-only">New category</span>
                <select
                  value={target}
                  disabled={pending}
                  onChange={(e) => setTarget(e.target.value)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                >
                  <option value="">Set category…</option>
                  {ordered.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={UNCATEGORIZED_FILTER}>Uncategorized</option>
                </select>
              </label>
              <ActionButton
                busyLabel={working}
                disabled={pending || !target || moveTargets.length === 0}
                onAction={() => run("category", moveTargets, targetName)}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 disabled:opacity-50"
              >
                Apply category
              </ActionButton>
              {toArchive.length > 0 ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(true)}
                  className="rounded-lg border border-red-500/60 px-2 py-1 text-red-600 disabled:opacity-50"
                >
                  Archive {toArchive.length}
                </button>
              ) : null}
              {toRestore.length > 0 ? (
                <ActionButton
                    busyLabel={working}
                  disabled={pending}
                  onAction={() => run("restore", toRestore)}
                  className="rounded-lg border border-[var(--color-border)] px-2 py-1 disabled:opacity-50"
                >
                  Restore {toRestore.length}
                </ActionButton>
              ) : null}
            </span>
          </>
        ) : null}
      </div>

      {result ? (
        <div
          data-component="ProjectsBulkResult"
          role="status"
          className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            {result.done > 0 ? (
              <p>
                {DONE_VERB[result.kind]} {plural(result.done)}
                {result.kind === "category" && result.label
                  ? ` to ${result.label}`
                  : ""}
                .
                {result.kind === "archive"
                  ? " You can bring them back from the Archived view."
                  : ""}
              </p>
            ) : null}
            {result.failed.length > 0 ? (
              <>
                <p className="text-red-600">
                  Couldn&apos;t {FAIL_VERB[result.kind]} {plural(result.failed.length)}{" "}
                  (still ticked):
                </p>
                <ul className="list-disc pl-5 text-[var(--color-muted)]">
                  {result.failed.map((f) => (
                    <li key={f.slug}>
                      <span className="text-[var(--color-fg)]">{f.name}</span>: {f.error}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setResult(null)}
            className="rounded-lg px-2 text-[var(--color-muted)]"
          >
            ×
          </button>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Archive ${plural(toArchive.length)}?`}
          body="They stop running and move to the Archived view, where you can restore them. A project with a run still in progress is skipped and stays ticked."
          confirmLabel={pending ? working : `Archive ${toArchive.length}`}
          busy={pending}
          onConfirm={() => run("archive", toArchive)}
          onCancel={() => {
            if (!pending) setConfirming(false);
          }}
        />
      ) : null}
    </div>
  );
}
