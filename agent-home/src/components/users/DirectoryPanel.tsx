"use client";

import { useState } from "react";

import { withProfileQuery } from "@/lib/profile";
import type { DirectoryEntry, DirectoryResponse } from "@/types";

/**
 * Who else is in this profile — visible to **every** enrolled principal.
 *
 * The entries come from this profile's principals, so a colleague enrolled only
 * in another profile on the same box is correctly absent: an account is
 * box-wide, but enrolment is local, and showing the former would leak another
 * profile's roster. Nothing here is admin-only information (no email, no
 * account state), which is why the weaker gate is safe.
 */
export function DirectoryPanel({
  initial,
  profile,
  searchable = true,
}: {
  initial: DirectoryResponse;
  /** The profile whose directory this is; absent → the session's. */
  profile?: string;
  searchable?: boolean;
}) {
  const [entries, setEntries] = useState<DirectoryEntry[]>(initial.entries);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  async function search(next: string) {
    setQuery(next);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (next.trim()) params.set("q", next.trim());
      const path = `/api/comms/directory?${params.toString()}`;
      const res = await fetch(profile ? withProfileQuery(path, profile) : path, {
        cache: "no-store",
      });
      if (res.ok) setEntries(((await res.json()) as DirectoryResponse).entries);
    } catch {
      // A stale list is non-fatal; the next keystroke re-reads.
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      data-component="DirectoryPanel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Directory</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {initial.profile ? `${initial.profile} · ` : ""}
          {entries.length} of {initial.total}
        </span>
      </div>
      {searchable ? (
        <input
          type="search"
          aria-label="Search the directory"
          placeholder="Search people"
          value={query}
          onChange={(e) => search(e.target.value)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        />
      ) : null}
      <ul data-component="DirectoryList" className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={entry.user_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">{entry.display || entry.user_id}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
              <span>{entry.role}</span>
              {entry.channels.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </span>
          </li>
        ))}
        {entries.length === 0 ? (
          <li className="text-sm text-[var(--color-muted)]">
            {loading ? "Searching…" : "Nobody else is enrolled in this profile yet."}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
