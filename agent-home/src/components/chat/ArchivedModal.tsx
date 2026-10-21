"use client";

import { useEffect, useState } from "react";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";

import { Spinner } from "@/components/ui/Spinner";
import { withProfileQuery } from "@/lib/chat/profile";
import type { SessionSummary } from "@/types";

function titleOf(s: SessionSummary): string {
  return s.title || s.preview || "Untitled";
}

/**
 * The archived-conversations popup, opened from the "Archived" button in the
 * session strip. Lists soft-archived conversations (`GET /api/chat/sessions?
 * archived=only`) and lets the user un-archive one — which restores it to the
 * top strip.
 */
export function ArchivedModal({
  onClose,
  onUnarchive,
  profile,
}: {
  onClose: () => void;
  onUnarchive: (id: string) => Promise<void>;
  /** Archived conversations belong to a profile, like every other session. */
  profile?: string;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          withProfileQuery("/api/chat/sessions?archived=only", profile),
          { cache: "no-store" },
        );
        const body = (await res.json()) as {
          sessions?: SessionSummary[];
          detail?: string;
        };
        if (!active) return;
        if (!res.ok) throw new Error(body.detail ?? "Failed to load archived list.");
        setSessions(body.sessions ?? []);
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error ? err.message : "Failed to load archived list.",
        );
        setSessions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile]);

  async function unarchive(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onUnarchive(id);
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unarchive failed.");
    } finally {
      setBusyId(null);
    }
  }

  const { run: unarchiveOnce } = useAction((id: string) => unarchive(id));

  return (
    <div
      data-component="ArchivedModal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80dvh] w-full max-w-sm flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Archived conversations</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[var(--color-muted)]"
          >
            Close
          </button>
        </div>

        {error ? (
          <p className="mb-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {sessions === null ? (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-2 py-8 text-center text-sm text-[var(--color-accent)]"
            >
              <Spinner size="md" />
              Loading your archive…
            </p>
          ) : sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted)]">
              No archived conversations.
            </p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-fg)]">
                  {titleOf(s)}
                </span>
                {/* `unarchive` already refuses while another row is in flight;
                  * disabling every row makes that visible instead of silently
                  * swallowing the tap. */}
                <ActionButton
                  onAction={() => unarchiveOnce(s.id)}
                  disabled={busyId !== null}
                  busy={busyId === s.id}
                  busyLabel="Restoring…"
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-60"
                >
                  Unarchive
                </ActionButton>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
