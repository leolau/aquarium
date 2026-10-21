"use client";

import { useState } from "react";

import { errorMessage } from "@/components/users/api";
import type { IdentityActivityResponse, IdentityEvent } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * Who did what to whom, read from the C5 change log rather than a private
 * table — so this panel and `hermes changes` cannot disagree about history.
 *
 * Loaded on demand: an audit trail is what an admin opens when something looks
 * wrong, not something worth fetching on every roster render. No raw invitation
 * token ever reaches a C5 payload, so nothing shown here can be replayed.
 */
export function IdentityActivityPanel() {
  const [events, setEvents] = useState<IdentityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/comms/members/activity?limit=50", {
        cache: "no-store",
      });
      const body = (await res.json()) as IdentityActivityResponse & {
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail ?? "The request was refused.");
      setEvents(body.events);
    } catch (err) {
      setError(errorMessage(err, "Could not load the audit trail."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-component="IdentityActivityPanel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Identity activity</h2>
        <ActionButton
          disabled={busy}
          onAction={load}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
        >
          {busy ? "Loading…" : events ? "Refresh" : "Load"}
        </ActionButton>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {events ? (
        <ul className="flex flex-col gap-1">
          {events.map((event) => (
            <li
              key={event.change_ref}
              className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs"
            >
              <span className="font-mono">{event.action}</span> · {event.user_id} · by{" "}
              {event.actor_user_id}
            </li>
          ))}
          {events.length === 0 ? (
            <li className="text-xs text-[var(--color-muted)]">
              No identity changes recorded yet.
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
