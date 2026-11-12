"use client";

import { useState } from "react";
import { useAction } from "@/lib/use-action";

import { ApprovalsList } from "@/components/inbox/ApprovalsList";
import { ChangesList } from "@/components/inbox/ChangesList";
import { IncomingsList } from "@/components/inbox/IncomingsList";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useUndoToast } from "@/components/ui/UndoToast";
import { useConfirm } from "@/components/ui/useConfirm";
import { useT } from "@/i18n";
import type {
  Change,
  ChangeOpResponse,
  IncomingsFacets,
  IncomingsResponse,
  Notification,
  NotificationAnswerResponse,
  NotificationsResponse,
  ChangesResponse,
} from "@/types";

export interface InboxViewProps {
  initialConfigured: boolean;
  initialNotifications: Notification[];
  initialChanges: Change[];
  initialIncomings: IncomingsResponse;
  incomingsFacets: IncomingsFacets;
  initialTab?: Tab;
}

export type Tab = "incomings" | "approvals" | "changes";

/** An error carrying the upstream HTTP status so callers can branch on it. */
class ForwardError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ForwardError";
    this.status = status;
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const parsed = (await res.json()) as T & { detail?: string; error?: string };
  if (!res.ok) {
    throw new ForwardError(
      res.status,
      parsed.detail ?? parsed.error ?? "The request was refused.",
    );
  }
  return parsed;
}

/**
 * The mobile comms inbox. A segmented switch flips between **Incomings** —
 * everything that arrived on any channel — the FG-10 **Approvals** queue
 * (grant/deny/acknowledge, deduped across surfaces) and the FG-12 **Changes**
 * log (undo/redo). Incomings leads because it is the tab with something in it
 * every day; approvals are the exception, not the traffic.
 *
 * Every mutation routes through the `agent-home` BFF under the C1 principal —
 * this view never decides settlement or reversibility, it forwards the user's
 * intent and re-reads the authoritative list afterwards.
 */
export function InboxView({
  initialConfigured,
  initialNotifications,
  initialChanges,
  initialIncomings,
  incomingsFacets,
  initialTab = "incomings",
}: InboxViewProps) {
  const [configured] = useState(initialConfigured);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [notifications, setNotifications] = useState<Notification[]>(
    initialNotifications,
  );
  const [changes, setChanges] = useState<Change[]>(initialChanges);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Ids the upstream engine reported it cannot replay (a 409). These rows are
  // `reversible` in the log but their inverse op was recorded by a flow FG-12
  // does not know how to reverse, so we present them as review-only rather
  // than re-offering an action that can never succeed.
  const t = useT("inbox");
  const { ask, dialog } = useConfirm();
  const { show: showUndo, toast } = useUndoToast();
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());

  async function refreshNotifications() {
    try {
      const res = await fetch("/api/comms/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as NotificationsResponse;
      setNotifications(body.notifications);
    } catch {
      // A stale list is non-fatal; the next action re-reads.
    }
  }

  async function refreshChanges() {
    try {
      const res = await fetch("/api/comms/changes", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as ChangesResponse;
      setChanges(body.changes);
    } catch {
      // A stale list is non-fatal.
    }
  }

  // One lock for the page: a second click while an answer or undo is in
  // flight is dropped instead of being sent again.
  const { run: exclusive } = useAction((work: () => Promise<void>) => work());

  async function answer(item: Notification, value: string) {
    if (item.kind === "approval" && value === "approved" && !item.reversible) {
      const ok = await ask({
        title: t("confirmApproveTitle", { title: item.title }),
        body: t("confirmApproveBody"),
        confirmLabel: t("confirmApprove"),
        cancelLabel: t("cancel"),
        tone: "accent",
      });
      if (!ok) return;
    }
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const resp = await postJson<NotificationAnswerResponse>(
        `/api/comms/notifications/${encodeURIComponent(item.id)}/answer`,
        { answer: value },
      );
      setNotice(
        resp.newly_answered
          ? `Answered "${item.title}" (${value}).` +
              (resp.action?.type === "send"
                ? resp.action.event === "sent"
                  ? " Reply sent."
                  : ` Send failed: ${resp.action.result?.error ?? resp.action.detail ?? "unknown"}.`
                : resp.action?.type === "revision"
                  ? " Back to work — you'll be told when the revision is ready."
                  : resp.action?.type === "rejected"
                    ? " Reply not sent."
                    : "")
          : `"${item.title}" was already answered on another surface.`,
      );
      await refreshNotifications();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The answer was refused.");
    } finally {
      setBusy(null);
    }
  }

  async function changeOp(change: Change, op: "undo" | "redo", fromToast = false) {
    setBusy(change.id);
    setError(null);
    setNotice(null);
    try {
      const resp = await postJson<ChangeOpResponse>(
        `/api/comms/changes/${encodeURIComponent(change.id)}/${op}`,
      );
      const message = t("changeDone", {
        op: op === "undo" ? t("undid") : t("redid"),
        kind: resp.target_kind,
      });
      if (fromToast) setNotice(message);
      else showUndo(message, () => changeOp(change, op === "undo" ? "redo" : "undo", true));
      await refreshChanges();
    } catch (err) {
      if (err instanceof ForwardError && err.status === 409) {
        // The log marks the row reversible, but the engine refused to replay
        // its inverse op. Flip the card to review-only instead of a red error.
        setBlocked((prev) => new Set(prev).add(change.id));
        setNotice(
          `This ${change.target_kind} change can't be reversed here — marked review-only.`,
        );
      } else {
        setError(
          err instanceof Error ? err.message : "The change could not be applied.",
        );
      }
    } finally {
      setBusy(null);
    }
  }

  const pendingCount = notifications.filter((n) => n.status === "pending").length;
  const reversibleCount = changes.filter((c) => c.reversible).length;

  return (
    <div data-component="InboxView" className="flex flex-col gap-4">
      {dialog}
      {toast}
      <div
        role="tablist"
        aria-label={t("tabs.label")}
        data-component="InboxTabs"
        className="flex w-full gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 lg:w-auto lg:self-start"
      >
        {(
          [
            ["incomings", t("tabs.arrived"), 0],
            ["approvals", t("tabs.approvals"), pendingCount],
            ["changes", t("tabs.changes"), reversibleCount],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            data-tab={key}
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex h-10 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-2 text-sm lg:flex-none lg:px-4 ${
              tab === key
                ? "bg-[var(--color-surface-2)] font-semibold text-[var(--color-fg)]"
                : "text-[var(--color-muted)]"
            }`}
          >
            <span className="truncate">{label}</span>
            {count > 0 ? (
              <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-xs tabular-nums text-[var(--color-accent-fg)]">
                {count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {!configured ? (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          {t("needsDatastore")}
        </div>
      ) : null}

      {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      {tab === "incomings" ? (
        <IncomingsList initial={initialIncomings} facets={incomingsFacets} />
      ) : (
        // Answering an approval or replaying a change is a write followed by a
        // re-read of the authoritative list, so the whole list is covered: the
        // rows the user can see are about to be replaced, and a second tap
        // would act against state that is already half-applied.
        <BusyRegion
          busy={busy !== null}
          label={tab === "approvals" ? "Sending your answer…" : "Applying the change…"}
        >
          {tab === "approvals" ? (
            <ApprovalsList
              notifications={notifications}
              busyId={busy}
              onAnswer={(item, value) => exclusive(() => answer(item, value))}
            />
          ) : (
            <ChangesList
              changes={changes}
              busyId={busy}
              onOp={(change, op) => exclusive(() => changeOp(change, op))}
              blockedIds={blocked}
            />
          )}
        </BusyRegion>
      )}
    </div>
  );
}
