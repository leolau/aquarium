"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ApprovalDetail } from "@/components/projects/CardApprovals";
import { CardTile, cardHref } from "@/components/projects/board/CardTile";
import {
  isTaskRow,
  reconcileTask,
  withAssignee,
  withStatus,
  type NeedsKind,
} from "@/components/projects/board/model";
import { useProjectAction, type ActionRequest } from "@/components/projects/useProjectAction";
import type { ProjectBoardTask, ProjectBoardView, ProjectCardApproval } from "@/types";

export type BoardUpdate = (fn: (board: ProjectBoardView) => ProjectBoardView) => void;

type Verb = "approve" | "unblock" | "allow" | "deny" | "assign" | "archive";

const PENDING: Record<Verb, string> = {
  approve: "Approving…",
  unblock: "Unblocking…",
  allow: "Allowing…",
  deny: "Denying…",
  assign: "Assigning…",
  archive: "Archiving…",
};

const FAILED: Record<Verb, string> = {
  approve: "Couldn't approve",
  unblock: "Couldn't unblock",
  allow: "Couldn't allow it",
  deny: "Couldn't deny it",
  assign: "Couldn't assign",
  archive: "Couldn't archive",
};

const NONE = "__none__";

const BTN = "rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium disabled:opacity-50";
const PRIMARY =
  "rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50";

/**
 * One card in "Needs you", with its one-tap verbs. Each card owns its own
 * `useProjectAction`, so cards lock independently: a card does one thing
 * at a time, the board moves it at once, the server's answer settles it,
 * and a refusal puts it back with the reason and a Retry.
 */
export function NeedsYouCard({
  slug,
  task,
  snapshot,
  kind,
  canAct,
  profiles,
  memberIds,
  runNo,
  now,
  update,
  onRelease,
  onHold,
  bulkBusy = false,
  bulkError = null,
}: {
  slug: string;
  /** The live row (`null` once an optimistic archive took it off the board). */
  task: ProjectBoardTask | null;
  /** The row as it was when the person acted — what a failure restores. */
  snapshot: ProjectBoardTask;
  kind: NeedsKind;
  canAct: boolean;
  profiles: string[];
  memberIds: ReadonlySet<string>;
  runNo: number | null;
  now: number;
  update: BoardUpdate;
  onHold: (task: ProjectBoardTask) => void;
  onRelease: (taskId: string) => void;
  /** Part of an Approve all that is in flight. */
  bulkBusy?: boolean;
  bulkError?: string | null;
}) {
  const action = useProjectAction<ProjectBoardTask>();
  const [verb, setVerb] = useState<Verb | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const before = useRef<ProjectBoardTask>(snapshot);
  const optimistic = useRef<((b: ProjectBoardView) => ProjectBoardView) | null>(null);
  const shown = task ?? snapshot;
  const base = `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(snapshot.id)}`;

  const busy = action.busy || bulkBusy;
  const holding = verb !== null && action.busy;
  // Off the strip only once the server confirmed and the refresh landed; a
  // refused card stays put (rolled back) with its reason and a Retry.
  useEffect(() => {
    if (verb !== null && !action.busy && !action.error) onRelease(snapshot.id);
  }, [verb, action.busy, action.error, onRelease, snapshot.id]);

  const rollback = () => update((b) => reconcileTask(b, before.current));

  const fire = async (
    v: Verb,
    path: string,
    request: ActionRequest<ProjectBoardTask>,
    apply: (b: ProjectBoardView) => ProjectBoardView,
  ) => {
    if (busy) return;
    before.current = shown;
    optimistic.current = apply;
    setVerb(v);
    onHold(shown);
    update(apply);
    const result = await action.run(path, {
      ...request,
      onSuccess: (data) => {
        if (isTaskRow(data)) update((b) => reconcileTask(b, data));
      },
    });
    if (result && !result.ok) rollback();
  };

  const retry = async () => {
    if (busy) return;
    onHold(before.current);
    if (optimistic.current) update(optimistic.current);
    const result = await action.retry();
    if (result && !result.ok) rollback();
  };

  const id = snapshot.id;
  const approve = () =>
    fire("approve", base, { method: "PATCH", body: { status: "ready" } }, (b) =>
      withStatus(b, id, "ready"),
    );
  const unblock = () =>
    fire(
      "unblock",
      `${base}/unblock`,
      { method: "POST", body: reason.trim() ? { reason: reason.trim() } : {} },
      (b) => withStatus(b, id, "ready"),
    );
  const approvals = kind === "unblock" ? shown.pending_approvals ?? [] : [];
  const decide = (approval: ProjectCardApproval, allow: boolean) => {
    const rest = approvals.filter((a) => a.key !== approval.key);
    return fire(
      allow ? "allow" : "deny",
      `${base}/approvals`,
      { method: "POST", body: { key: approval.key, decision: allow ? "approve" : "deny" } },
      (b) =>
        rest.length === 0
          ? withStatus(b, id, "ready")
          : reconcileTask(b, { ...shown, pending_approvals: rest }),
    );
  };
  const archive = () =>
    fire("archive", base, { method: "PATCH", body: { status: "archived" } }, (b) =>
      withStatus(b, id, "archived"),
    );
  const assign = (value: string) => {
    const assignee = value === NONE ? null : value;
    return fire("assign", base, { method: "PATCH", body: { assignee } }, (b) =>
      withAssignee(b, id, assignee),
    );
  };

  const error = action.error ?? bulkError;
  const pendingVerb: Verb | null = bulkBusy ? "approve" : action.busy ? verb : null;

  return (
    <CardTile
      slug={slug}
      task={shown}
      runNo={runNo}
      memberIds={memberIds}
      now={now}
      highlight
    >
      {approvals.map((approval) => (
        <div
          key={approval.key}
          data-component="CardApproval"
          data-approval-key={approval.key}
          className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/5 px-2 py-1.5 text-xs"
        >
          <div className="font-medium">Waiting on you: allow {approval.label}?</div>
          {approval.detail ? (
            <details className="mt-0.5">
              <summary className="cursor-pointer text-[var(--color-muted)]">What it wants to do</summary>
              <ApprovalDetail approval={approval} />
            </details>
          ) : null}
          {canAct ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <ActionButton
                busy={pendingVerb === "allow"}
                disabled={busy}
                pendingLabel={PENDING.allow}
                onClick={() => void decide(approval, true)}
                className={PRIMARY}
              >
                Allow on this card
              </ActionButton>
              <ActionButton
                busy={pendingVerb === "deny"}
                disabled={busy}
                pendingLabel={PENDING.deny}
                onClick={() => void decide(approval, false)}
                className={BTN}
              >
                Deny
              </ActionButton>
            </div>
          ) : null}
        </div>
      ))}
      <div data-component="NeedsYouActions" className="mt-2 flex flex-wrap items-center gap-1.5">
        {holding && !task ? (
          <span role="status" className="text-xs text-[var(--color-muted)]">
            {PENDING[verb ?? "archive"]}
          </span>
        ) : null}
        {kind === "review" ? (
          <Link href={cardHref(slug, id)} className={PRIMARY}>
            Review
          </Link>
        ) : null}
        {canAct && kind === "approve" ? (
          <ActionButton
            busy={pendingVerb === "approve"}
            disabled={busy}
            pendingLabel={PENDING.approve}
            onClick={() => void approve()}
            className={PRIMARY}
          >
            Approve
          </ActionButton>
        ) : null}
        {canAct && kind === "unblock" && approvals.length === 0 ? (
          <>
            <ActionButton
              busy={pendingVerb === "unblock"}
              disabled={busy}
              pendingLabel={PENDING.unblock}
              onClick={() => void unblock()}
              className={PRIMARY}
            >
              {reason.trim() ? "Unblock with note" : "Unblock"}
            </ActionButton>
            {!reasonOpen ? (
              <button
                type="button"
                onClick={() => setReasonOpen(true)}
                className="px-1 text-xs text-[var(--color-muted)] underline"
              >
                Add a note
              </button>
            ) : null}
          </>
        ) : null}
        {canAct && profiles.length > 0 ? (
          <label className="relative">
            <span className="sr-only">Assign {shown.title}</span>
            <select
              aria-label={`Assign ${shown.title}`}
              value=""
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void assign(e.target.value);
              }}
              className={`${BTN} bg-[var(--color-surface)]`}
            >
              <option value="">{pendingVerb === "assign" ? PENDING.assign : "Assign ▾"}</option>
              {profiles.map((p) => (
                <option key={p} value={p} disabled={p === shown.assignee}>
                  {p}
                </option>
              ))}
              {shown.assignee ? <option value={NONE}>No one</option> : null}
            </select>
          </label>
        ) : null}
        {canAct ? (
          <ActionButton
            busy={pendingVerb === "archive"}
            disabled={busy}
            pendingLabel={PENDING.archive}
            onClick={() => void archive()}
            className="rounded-lg px-2 py-1 text-xs text-[var(--color-muted)] disabled:opacity-50"
          >
            Archive
          </ActionButton>
        ) : null}
        {!canAct ? (
          <span className="text-xs text-[var(--color-muted)]">A project member can act on this.</span>
        ) : null}
      </div>
      {canAct && kind === "unblock" && reasonOpen ? (
        <textarea
          aria-label={`Why unblock ${shown.title}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Optional: what changed, so the agent knows"
          className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      ) : null}
      {error ? (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-danger)]">
          <span>
            {FAILED[verb ?? "approve"]}: {error}
          </span>
          {action.error ? (
            <ActionButton
              busy={action.busy}
              pendingLabel="Retrying…"
              onClick={() => void retry()}
              className="rounded-md border border-red-400/50 px-2 py-0.5 text-xs"
            >
              Retry
            </ActionButton>
          ) : null}
        </div>
      ) : null}
    </CardTile>
  );
}
