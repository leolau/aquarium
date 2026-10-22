"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/outputs/ActionError";
import {
  attachBody,
  otherFilesHeading,
  outputsAwaitingDelivery,
  suggestedOutput,
  unattachedByRun,
  unattachedSentence,
} from "@/components/projects/outputs/artifacts";
import { FileBadge } from "@/components/projects/outputs/FileBadge";
import { OpenArtifact, type OpenFile } from "@/components/projects/outputs/OpenArtifact";
import {
  newIdempotencyKey,
  sendProjectAction,
  useProjectAction,
} from "@/components/projects/useProjectAction";
import { useRefresh } from "@/components/ui/useRefresh";
import type { ProjectArtifact, ProjectOutputWithDeliveries } from "@/types";

export interface AttachResult {
  delivery_id: string;
  output_id: string;
  by?: string;
}

/**
 * Files a run produced that no declared output owns. While an open output
 * has nothing delivered, they are a warning — one of them may be what it
 * should deliver — with one "Add to" action per file (its own lock) through
 * the existing deliver route, plus an "Add all" for the common case where
 * every file answers the same output. Once every output has a delivery they
 * are just the run's working files: a collapsed list whose action adds a
 * file as a new version.
 */
export function UnattachedWarning({
  slug,
  artifacts,
  outputs,
  archived,
  onAttached,
  onOpenFile,
  onDownloadFile,
  resolving,
}: {
  slug: string;
  artifacts: ProjectArtifact[];
  outputs: ProjectOutputWithDeliveries[];
  archived: boolean;
  onAttached: (file: ProjectArtifact, result: AttachResult) => void;
  onOpenFile?: OpenFile;
  onDownloadFile?: OpenFile;
  resolving?: string | null;
}) {
  const groups = unattachedByRun(artifacts);
  if (groups.length === 0) return null;
  const targets = outputs.filter((o) => o.status !== "accepted" && o.status !== "dropped");
  const awaiting = outputsAwaitingDelivery(outputs);
  const quiet = awaiting.length === 0 && outputs.some((o) => o.status !== "dropped");
  const suggested = suggestedOutput(outputs);
  const rows = (group: (typeof groups)[number]) => (
    <ul className="mt-2 flex flex-col gap-1.5">
      {group.files.map((file) => (
        <AttachRow
          key={file.id}
          slug={slug}
          file={file}
          targets={targets}
          suggestedId={suggested?.id ?? null}
          archived={archived}
          quiet={quiet}
          onAttached={onAttached}
          onOpenFile={onOpenFile} onDownloadFile={onDownloadFile}
          resolving={resolving}
        />
      ))}
    </ul>
  );

  if (quiet) {
    return (
      <section data-component="OtherRunFiles" className="flex flex-col gap-2">
        {groups.map((group) => (
          <details
            key={String(group.runNo)}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <summary className="cursor-pointer text-sm font-medium">{otherFilesHeading(group)}</summary>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Working files the run made along the way — research, templates,
              drafts. Every output already has a delivery, so nothing here
              needs adding.
              {!archived && targets.length > 0
                ? " Use “Add as a new version” only if one of these files should become the output’s latest version."
                : ""}
            </p>
            {rows(group)}
          </details>
        ))}
      </section>
    );
  }

  const awaitingLine =
    awaiting.length === 1
      ? `“${awaiting[0].title}” has nothing delivered yet.`
      : `${awaiting.length} outputs have nothing delivered yet.`;
  return (
    <section
      data-component="UnattachedWarning"
      role="status"
      className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"
    >
      {groups.map((group) => (
        <div key={String(group.runNo)} className="mb-3 last:mb-0">
          <p className="text-sm font-medium text-[var(--color-warn-text)]">{unattachedSentence(group)}</p>
          {targets.length > 0 ? (
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">
              {awaitingLine} If one of these files is what it should deliver,
              add it to that output — the output then reads as delivered.
              Files that are only working material can stay where they are.
            </p>
          ) : null}
          {!archived && targets.length > 0 && group.files.length > 1 ? (
            <AttachAll
              slug={slug}
              files={group.files}
              targets={targets}
              suggestedId={suggested?.id ?? null}
              onAttached={onAttached}
            />
          ) : null}
          {rows(group)}
        </div>
      ))}
      {targets.length === 0 && !archived ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Declare an output below to add these files to it.
        </p>
      ) : null}
    </section>
  );
}

/** "which output does this file deliver" — the select + attach button row,
 * shared by the per-file row and the group Attach-all. */
function TargetSelect({
  targets,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  targets: ProjectOutputWithDeliveries[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  if (targets.length <= 1) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className="min-w-0 max-w-full flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
    >
      {targets.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );
}

function initialTarget(
  targets: ProjectOutputWithDeliveries[],
  suggestedId: string | null,
): string {
  return suggestedId && targets.some((t) => t.id === suggestedId)
    ? suggestedId
    : (targets[0]?.id ?? "");
}

/** Add every file in the group to one output — sequential deliver calls,
 * so a stop-on-error leaves the rest still attachable by hand. */
function AttachAll({
  slug,
  files,
  targets,
  suggestedId,
  onAttached,
}: {
  slug: string;
  files: ProjectArtifact[];
  targets: ProjectOutputWithDeliveries[];
  suggestedId: string | null;
  onAttached: (file: ProjectArtifact, result: AttachResult) => void;
}) {
  const { refresh } = useRefresh();
  const [targetId, setTargetId] = useState(() => initialTarget(targets, suggestedId));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  if (!target) return null;

  const attachAll = async () => {
    if (busy) return;
    setBusy(true);
    setDone(0);
    setError(null);
    try {
      for (const file of files) {
        const result = await sendProjectAction<AttachResult>(
          `/api/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(target.id)}/deliver`,
          newIdempotencyKey(),
          { body: attachBody(file) },
        );
        if (!result.ok) {
          setError(result.error ?? "That did not go through.");
          return;
        }
        if (result.data) onAttached(file, result.data);
        setDone((n) => n + 1);
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div
      data-component="AttachAll"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-surface)] px-2 py-1.5"
    >
      <span className="text-xs font-medium text-[var(--color-fg)]">
        Add all {files.length} to
      </span>
      <TargetSelect
        targets={targets}
        value={targetId}
        onChange={setTargetId}
        disabled={busy}
        ariaLabel={`Output for all ${files.length} files`}
      />
      <ActionButton
        busy={busy}
        pendingLabel={`Adding ${done}/${files.length}…`}
        onClick={() => void attachAll()}
        className="rounded-lg border border-[var(--color-warn)] px-3 py-1 text-xs font-medium text-[var(--color-warn-text)] disabled:opacity-50"
      >
        Add all
      </ActionButton>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

function AttachRow({
  slug,
  file,
  targets,
  suggestedId,
  archived,
  quiet,
  onAttached,
  onOpenFile,
  onDownloadFile,
  resolving,
}: {
  slug: string;
  file: ProjectArtifact;
  targets: ProjectOutputWithDeliveries[];
  suggestedId: string | null;
  archived: boolean;
  quiet: boolean;
  onAttached: (file: ProjectArtifact, result: AttachResult) => void;
  onOpenFile?: OpenFile;
  onDownloadFile?: OpenFile;
  resolving?: string | null;
}) {
  const action = useProjectAction<AttachResult>();
  const [targetId, setTargetId] = useState<string>(() =>
    initialTarget(targets, suggestedId),
  );
  const target = targets.find((t) => t.id === targetId) ?? null;
  return (
    <li data-component="AttachRow" className="rounded-lg bg-[var(--color-surface)] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <FileBadge file={file} />
        <span className="min-w-0 flex-1 break-all text-sm">{file.title}</span>
        <OpenArtifact file={file} onOpenFile={onOpenFile} onDownloadFile={onDownloadFile} resolving={resolving} />
      </div>
      {!archived && target ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <TargetSelect
            targets={targets}
            value={targetId}
            onChange={setTargetId}
            disabled={action.busy}
            ariaLabel={`Output for ${file.title}`}
          />
          <ActionButton
            busy={action.busy}
            pendingLabel="Adding…"
            onClick={() =>
              void action.run(
                `/api/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(target.id)}/deliver`,
                { body: attachBody(file), onSuccess: (data) => onAttached(file, data) },
              )
            }
            className={
              quiet
                ? "rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50"
                : "rounded-lg border border-[var(--color-warn)] px-3 py-1 text-xs font-medium text-[var(--color-warn-text)] disabled:opacity-50"
            }
          >
            {quiet
              ? targets.length > 1
                ? "Add as a new version"
                : `Add as a new version of “${target.title}”`
              : targets.length > 1
                ? "Add to output"
                : `Add to “${target.title}”`}
          </ActionButton>
        </div>
      ) : null}
      <ActionError action={action} />
    </li>
  );
}
