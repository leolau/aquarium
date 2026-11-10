"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { sortCategories } from "@/components/projects/categories/useProjectCategories";
import { UNCATEGORIZED_FILTER } from "@/components/projects/filters";
import {
  newIdempotencyKey,
  sendProjectAction,
} from "@/components/projects/useProjectAction";
import { useAction } from "@/lib/use-action";
import type { ProjectCategory, ProjectListItem, ProjectStatus } from "@/types";

/** How long clicks on the list stay swallowed after a bulk action ends. */
export const SETTLE_MS = 600;

/** A state the bulk menu can move ticked projects to. */
export type BulkStateMove = "active" | "paused" | "done" | "archive" | "restore";

type BulkKind = "category" | BulkStateMove | "undo";

interface BulkJob {
  project: ProjectListItem;
  path: string;
  method: "PATCH" | "POST";
  body: Record<string, unknown>;
}

interface BulkResult {
  kind: BulkKind;
  /** For "category": the category the projects moved to. */
  label?: string;
  done: number;
  failed: { slug: string; name: string; error: string }[];
  /** Left unsent because the server stopped answering (e.g. restarting). */
  notSent: number;
  /** Ticked but already in that state, so not sent. */
  skipped: number;
  /** For a status change: each moved project's previous status, for Undo. */
  undo?: { project: ProjectListItem; status: ProjectStatus }[];
}

interface StateOption {
  move: BulkStateMove;
  label: string;
  hint: string;
  /** Why a ticked project is left out, e.g. "already active". */
  skipReason: string;
  eligible: (p: ProjectListItem) => boolean;
}

/**
 * The states the backend lets a person move a project to: `PATCH
 * /api/projects/{slug}` `{status}` for active / paused / done (the same
 * write as Edit brief's Pause/Resume and Mark project done), and the
 * lifecycle routes for archive and restore, which keep the `archived` flag
 * and the schedule in step. Archived projects only offer Restore: a status
 * PATCH would leave the archived flag behind.
 */
export const STATE_OPTIONS: readonly StateOption[] = [
  {
    move: "active",
    label: "Active",
    hint: "Runs again, on schedule or by hand.",
    skipReason: "already active",
    eligible: (p) => !p.archived && p.status !== "active",
  },
  {
    move: "paused",
    label: "Paused",
    hint: "No new runs until resumed.",
    skipReason: "already paused",
    eligible: (p) => !p.archived && p.status !== "paused",
  },
  {
    move: "done",
    label: "Done",
    hint: "Goal reached. No new runs; stays on the record.",
    skipReason: "already done",
    eligible: (p) => !p.archived && p.status !== "done",
  },
  {
    move: "archive",
    label: "Archived",
    hint: "Off the list and stops running. Restore any time.",
    skipReason: "already archived",
    eligible: (p) => !p.archived,
  },
  {
    move: "restore",
    label: "Restore (as Paused)",
    hint: "Back on the list, paused until you resume it.",
    skipReason: "not archived",
    eligible: (p) => p.archived,
  },
];

/** Waits before re-sending to a server that did not answer: a deploy
 * restarts it for ~30s, so ~20s of retries ride most of that out. */
export const UNREACHABLE_RETRY_MS = [2_000, 6_000, 12_000];

/** No answer from the AI layer (network, or the BFF's 502–504), as opposed
 * to a refusal: worth re-sending with the same idempotency key. */
function unreachable(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DONE_VERB: Record<BulkKind, string> = {
  category: "Moved",
  active: "Set",
  paused: "Paused",
  done: "Marked",
  archive: "Archived",
  restore: "Restored",
  undo: "Put back",
};

const DONE_TAIL: Partial<Record<BulkKind, string>> = {
  active: " to Active",
  done: " as Done",
  restore: " as Paused",
  undo: " to their previous state",
  archive: ". You can bring them back from the Archived view",
};

const FAIL_VERB: Record<BulkKind, string> = {
  category: "move",
  active: "set active",
  paused: "pause",
  done: "mark done",
  archive: "archive",
  restore: "restore",
  undo: "put back",
};

function plural(n: number): string {
  return `${n} ${n === 1 ? "project" : "projects"}`;
}

function stateJob(move: BulkStateMove, project: ProjectListItem): BulkJob {
  const path = `/api/projects/${encodeURIComponent(project.slug)}`;
  return move === "archive" || move === "restore"
    ? { project, path: `${path}/${move}`, method: "POST", body: {} }
    : { project, path, method: "PATCH", body: { status: move } };
}

/**
 * The list's bulk actions on the ticked projects: set their category, or
 * change their state from the "Change state (N)" menu (active, paused, done,
 * archived, or restore archived ones). Each project goes through its own
 * existing endpoint (`PATCH /api/projects/{slug}` `{category_id}` /
 * `{status}`, `POST …/archive`, `POST …/restore`) one at a time, so every
 * project keeps its own permission check and audit note, and one refusal
 * (e.g. a run still open) is reported by name without stopping the rest.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    waiting?: boolean;
  } | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [running, setRunning] = useState<BulkKind | null>(null);
  // Briefly after an action the layout shifts (rows untick, the panel
  // changes), so the second click of a double-click must not land on a row.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const selectedSlugs = new Set(selected.map((p) => p.slug));
  const pageAll =
    pageItems.length > 0 && pageItems.every((p) => selectedSlugs.has(p.slug));
  const toArchive = selected.filter((p) => !p.archived);
  const ordered = sortCategories(categories);

  async function apply(
    kind: BulkKind,
    jobs: BulkJob[],
    extra: Pick<BulkResult, "label" | "skipped"> = { skipped: 0 },
  ): Promise<void> {
    setMenuOpen(false);
    setRunning(kind);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettling(false);
    setProgress({ done: 0, total: jobs.length });
    const succeeded: ProjectListItem[] = [];
    const failed: BulkResult["failed"] = [];
    let notSent = 0;
    for (const [i, job] of jobs.entries()) {
      // One key per project, reused on every re-send so a write that did
      // land is never applied twice.
      const key = newIdempotencyKey();
      const send = () =>
        sendProjectAction(job.path, key, { method: job.method, body: job.body });
      let res = await send();
      for (const ms of UNREACHABLE_RETRY_MS) {
        if (res.ok || !unreachable(res.status)) break;
        setProgress({ done: i, total: jobs.length, waiting: true });
        await sleep(ms);
        res = await send();
      }
      if (!res.ok && unreachable(res.status)) {
        // Still no answer: stop instead of failing every remaining one.
        notSent = jobs.length - i;
        break;
      }
      if (res.ok) succeeded.push(job.project);
      else
        failed.push({
          slug: job.project.slug,
          name: job.project.name,
          error: res.error ?? "That did not go through.",
        });
      setProgress({ done: i + 1, total: jobs.length });
    }
    setProgress(null);
    setRunning(null);
    setConfirming(false);
    setSettling(true);
    settleTimer.current = setTimeout(() => setSettling(false), SETTLE_MS);
    const undoable = kind === "active" || kind === "paused" || kind === "done";
    setResult({
      kind,
      ...extra,
      done: succeeded.length,
      failed,
      notSent,
      undo:
        undoable && succeeded.length > 0
          ? succeeded.map((project) => ({ project, status: project.status }))
          : undefined,
    });
    onDone(succeeded.map((p) => p.slug));
  }

  const { run, pending } = useAction(apply);

  function changeState(move: BulkStateMove): void {
    const option = STATE_OPTIONS.find((o) => o.move === move)!;
    const targets = selected.filter(option.eligible);
    void run(
      move,
      targets.map((p) => stateJob(move, p)),
      { skipped: selected.length - targets.length },
    );
  }

  function undo(entries: NonNullable<BulkResult["undo"]>): Promise<void> {
    return run(
      "undo",
      entries.map(({ project, status }) => ({
        project,
        path: `/api/projects/${encodeURIComponent(project.slug)}`,
        method: "PATCH",
        body: { status },
      })),
    ).then(() => undefined);
  }

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // While a bulk action runs, and just after, a click outside the bar (the
  // list under the pointer) is swallowed instead of opening a project.
  const guarding = pending || settling;
  useEffect(() => {
    if (!guarding) return;
    function swallow(e: MouseEvent) {
      if (e.target instanceof Node && barRef.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("click", swallow, true);
    return () => window.removeEventListener("click", swallow, true);
  }, [guarding]);

  // The menu takes focus when it opens and gives it back on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")
      ?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role=menuitem]:not([disabled])",
      ) ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? items[(at + 1) % items.length]
        : items[(at - 1 + items.length) % items.length];
    next?.focus();
  }

  const moveTargets = selected.filter(
    (p) => (p.category_id ?? UNCATEGORIZED_FILTER) !== target,
  );
  const targetName =
    target === UNCATEGORIZED_FILTER
      ? "Uncategorized"
      : ordered.find((c) => c.id === target)?.name;
  const verb = running === "undo" ? "Undoing…" : "Working…";
  const working = progress?.waiting
    ? "Waiting for the server…"
    : progress
      ? `${verb} ${progress.done} of ${progress.total}`
      : verb;

  return (
    <div
      ref={barRef}
      data-component="ProjectsBulkBar"
      data-guarding={guarding ? "true" : undefined}
      className={`flex flex-col gap-2 text-xs ${guarding ? "cursor-progress" : ""}`}
    >
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
                onAction={() =>
                  run(
                    "category",
                    moveTargets.map((p) => ({
                      project: p,
                      path: `/api/projects/${encodeURIComponent(p.slug)}`,
                      method: "PATCH" as const,
                      body: {
                        category_id: target === UNCATEGORIZED_FILTER ? null : target,
                      },
                    })),
                    { label: targetName, skipped: 0 },
                  )
                }
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 disabled:opacity-50"
              >
                Apply category
              </ActionButton>
              <div data-component="ProjectsStateMenu" className="relative">
                <button
                  ref={triggerRef}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-busy={pending}
                  disabled={pending}
                  onClick={() => setMenuOpen((open) => !open)}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-accent)]/60 px-2 py-1 font-medium text-[var(--color-accent)] disabled:opacity-50"
                >
                  {pending ? working : `Change state (${selected.length})`}
                  <span aria-hidden="true">▾</span>
                </button>
                {menuOpen ? (
                  <>
                    <button
                      type="button"
                      aria-label="Close menu"
                      tabIndex={-1}
                      onClick={() => setMenuOpen(false)}
                      className="fixed inset-0 z-[65] cursor-default bg-black/40 sm:bg-transparent"
                    />
                    <div
                      ref={menuRef}
                      role="menu"
                      aria-label={`Change state of ${plural(selected.length)}`}
                      onKeyDown={onMenuKey}
                      className="fixed inset-x-0 bottom-0 z-[70] flex flex-col gap-0.5 rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:mt-1 sm:w-72 sm:rounded-xl sm:p-1"
                      style={{ paddingBottom: "calc(var(--safe-bottom) + 0.5rem)" }}
                    >
                      <p className="px-3 pb-1 pt-2 text-xs text-[var(--color-muted)] sm:pt-1">
                        Move {plural(selected.length)} to:
                      </p>
                      {STATE_OPTIONS.map((option) => {
                        const count = selected.filter(option.eligible).length;
                        const skip = selected.length - count;
                        return (
                          <button
                            key={option.move}
                            type="button"
                            role="menuitem"
                            data-move={option.move}
                            disabled={count === 0}
                            onClick={() => {
                              if (option.move === "archive") {
                                setMenuOpen(false);
                                setConfirming(true);
                              } else changeState(option.move);
                            }}
                            className={`flex w-full flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-[var(--color-surface-2)] focus:bg-[var(--color-surface-2)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                              option.move === "archive" ? "text-[var(--color-danger)]" : "text-[var(--color-fg)]"
                            }`}
                          >
                            <span className="text-sm font-medium">
                              {option.label}
                              {count > 0 && skip > 0 ? (
                                <span className="font-normal text-[var(--color-muted)]">
                                  {" "}
                                  · {count} of {selected.length}
                                </span>
                              ) : null}
                            </span>
                            <span className="text-xs text-[var(--color-muted)]">
                              {count === 0
                                ? `All ticked are ${option.skipReason}.`
                                : skip > 0
                                  ? `${option.hint} ${skip} ${option.skipReason}, left as is.`
                                  : option.hint}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}
              </div>
            </span>
          </>
        ) : null}
      </div>

      {result || running ? (
        <div
          data-component="ProjectsBulkResult"
          role="status"
          aria-busy={pending}
          className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            {running ? (
              <p data-component="ProjectsBulkWorking" className="font-medium text-[var(--color-accent)]">
                {working}
              </p>
            ) : null}
            {result ? (
            <div className={running ? "opacity-50" : undefined}>
            {result.done > 0 ? (
              <p>
                {DONE_VERB[result.kind]} {plural(result.done)}
                {result.kind === "category" && result.label
                  ? ` to ${result.label}`
                  : (DONE_TAIL[result.kind] ?? "")}
                .
                {result.skipped > 0
                  ? ` ${plural(result.skipped)} ${result.skipped === 1 ? "was" : "were"} already there, left as is.`
                  : ""}
              </p>
            ) : null}
            {result.notSent > 0 ? (
              <p data-component="ProjectsBulkNotSent" className="text-[var(--color-danger)]">
                The server didn&apos;t answer (it may be restarting), so{" "}
                {plural(result.notSent)} {result.notSent === 1 ? "was" : "were"}{" "}
                not changed. They&apos;re still ticked: try again in a minute.
              </p>
            ) : null}
            {result.failed.length > 0 ? (
              <>
                <p className="text-[var(--color-danger)]">
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
            {result.done === 0 && result.skipped > 0 && result.failed.length === 0 && result.notSent === 0 ? (
              <p>Nothing to change: every ticked project was already there.</p>
            ) : null}
            </div>
            ) : null}
          </div>
          {result?.undo ? (
            <ActionButton
              busy={running === "undo"}
              busyLabel={working}
              disabled={pending}
              onAction={() => undo(result.undo!)}
              className="shrink-0 rounded-lg border border-[var(--color-border)] px-2 py-1 font-medium text-[var(--color-accent)] disabled:opacity-50"
            >
              Undo
            </ActionButton>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            disabled={pending}
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
          body={`They stop running and move to the Archived view, where you can restore them (they come back as Paused). A project with a run still in progress is skipped and stays ticked.${
            selected.length > toArchive.length
              ? ` ${plural(selected.length - toArchive.length)} already archived ${selected.length - toArchive.length === 1 ? "is" : "are"} left as is.`
              : ""
          }`}
          confirmLabel={pending ? working : `Archive ${toArchive.length}`}
          busy={pending}
          onConfirm={() => changeState("archive")}
          onCancel={() => {
            if (!pending) setConfirming(false);
          }}
        />
      ) : null}
    </div>
  );
}
