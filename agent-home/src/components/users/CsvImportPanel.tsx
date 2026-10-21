"use client";

import { useState } from "react";

import { activationUrl, errorMessage, sendJson } from "@/components/users/api";
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
 * order, for the admin to hand out.
 */
export function CsvImportPanel({ profile }: { profile: string }) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<MemberImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await sendJson<MemberImportResponse>("/api/comms/members/import", "POST", {
          csv,
          profile,
          dry_run: dryRun,
        }),
      );
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
      <p className="text-xs text-[var(--color-muted)]">
        One <code>email,display,role</code> per line. Previewed against{" "}
        <code>{profile}</code> before anything is created.
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
