"use client";

import { useState } from "react";

import { activationUrl, errorMessage, sendJson } from "@/components/users/api";
import { targetOptions } from "@/components/users/CreateUserForm";
import { withProfileQuery } from "@/lib/profile";
import type { MemberImportResponse } from "@/types";
import { ActionButton } from "@/components/ui/ActionButton";

/**
 * Bulk enrolment from `email,display,role` CSV.
 *
 * Preview is not optional politeness: applying forty rows mints forty
 * invitations, and the difference between "will create" and "already enrolled"
 * is invisible from the spreadsheet. So the panel previews first and only then
 * offers Apply, and a bad row is reported per-line rather than aborting the
 * batch — one typo in row 12 shouldn't strand rows 13-40.
 *
 * The activation links for newly created accounts are shown once here, in
 * order, for the admin to hand out — as the server returned them, profile and
 * all.
 *
 * FG-28 C4: the target is picked from `profiles` (the caller's administered
 * profiles), starting on the one being viewed. Changing it drops the preview:
 * a preview of `hr` is not permission to apply into `default`.
 */
export function CsvImportPanel({
  profile,
  profiles = [],
  onApplied,
}: {
  /** The profile being viewed — the target until another is picked. */
  profile: string;
  /** The profiles the caller administers; a picker appears for two or more. */
  profiles?: string[];
  /** Told after an apply, with the profile it went into. */
  onApplied?: (target: string, result: MemberImportResponse) => unknown;
}) {
  const [target, setTarget] = useState(profile);
  const options = targetOptions(profile, profiles);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<MemberImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const outcome = await sendJson<MemberImportResponse>(
        withProfileQuery("/api/comms/members/import", target),
        "POST",
        { csv, profile: target, dry_run: dryRun },
      );
      setResult(outcome);
      if (!dryRun) await onApplied?.(target, outcome);
    } catch (err) {
      setError(errorMessage(err, "The import was refused."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-component="CsvImportPanel"
      className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <h2 className="text-sm font-medium">Bulk import</h2>
      {options.length > 1 ? (
        <label className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--color-muted)]">Import into</span>
          <select
            aria-label="Import into profile"
            value={target}
            disabled={busy}
            onChange={(e) => {
              setTarget(e.target.value);
              setResult(null);
              setError(null);
            }}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">
        One <code>email,display,role</code> per line. Previewed against{" "}
        <code>{target}</code> before anything is created.
      </p>
      <textarea
        aria-label="CSV rows"
        rows={4}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder="mia@example.com,Mia,member"
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <ActionButton
          disabled={busy || !csv.trim()}
          onAction={() => run(true)}
          className="rounded-lg bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
        >
          {busy ? "Working…" : "Preview"}
        </ActionButton>
        <ActionButton
          disabled={busy || !result || !result.dry_run}
          onAction={() => run(false)}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          Apply
        </ActionButton>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {result ? (
        <div data-component="CsvImportResult" className="flex flex-col gap-2">
          <p className="text-xs text-[var(--color-muted)]">
            {result.dry_run ? "Preview" : "Applied"}: {result.total} row
            {result.total === 1 ? "" : "s"}, {result.failed} problem
            {result.failed === 1 ? "" : "s"}.
          </p>
          <ul className="flex flex-col gap-1">
            {result.rows.map((row) => (
              <li
                key={`${row.line}-${row.email}`}
                className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs"
              >
                <span className="font-mono">{row.line}</span> {row.email || "(blank)"} ·{" "}
                {row.error ? (
                  <span className="text-red-300">{row.error}</span>
                ) : (
                  <span>{row.planned}</span>
                )}
                {row.activation_path ? (
                  <span className="mt-1 block break-all font-mono">
                    {activationUrl(row.activation_path)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
