"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { Sheet, inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { JSON_HEADERS, formatWhen, personName, readJson } from "@/components/sites/format";
import { useLocale, useT } from "@/i18n";
import type { DirectoryEntry } from "@/types";
import type { DataSourceDoc, DictionaryEntry, DictionaryVersion } from "@/types/data";

import { ShareSheet } from "./ShareSheet";
import { allows, columnsToText, dataPath, entryOf, textToColumns } from "./format";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--color-fg)] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * Figma "Dictionary detail": the version bar, a table list (a picker on
 * phones) beside the selected table's entry, history with Restore, Share,
 * Edit (adds to the draft) and Build dictionary (opens a chat, unsent).
 */
export function DictionaryDetail({
  doc,
  versions,
  directory,
}: {
  doc: DataSourceDoc;
  versions: DictionaryVersion[];
  directory: DirectoryEntry[];
}) {
  const t = useT("data");
  const locale = useLocale();
  const router = useRouter();
  const { source, approved, draft } = doc;
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const tables = useMemo(() => Object.keys(approved?.entries?.tables ?? {}).sort(), [approved]);
  const [picked, setPicked] = useState<string>(tables[0] ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPropose = allows(source.access, "propose");
  const canManage = allows(source.access, "manage");
  const entry = picked ? entryOf(approved?.entries, picked) : null;
  const buildPrompt = t("build.prompt", { source: source.kind === "app" ? "app" : source.name });

  async function restore(version: number) {
    setError(null);
    try {
      await readJson(await fetch(dataPath(source.id, "versions", String(version), "restore"), { method: "POST" }));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setRestoring(null);
  }

  return (
    <div data-component="DictionaryDetail" className="flex flex-col gap-4 pb-24 lg:pb-8">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div data-component="VersionBar" className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm">
        {approved ? (
          <>
            <Pill tone="success">{t("status.approved", { v: approved.version })}</Pill>
            <span className="text-[var(--color-muted)]">
              {t("detail.answersUse", { who: personName(people, approved.approved_by), when: formatWhen(approved.approved_at, locale) })}
            </span>
          </>
        ) : (
          <span className="text-[var(--color-muted)]">{t("detail.noneApproved")}</span>
        )}
        <span className="flex-1" />
        {draft && canPropose ? (
          <Link href={`/data/${source.id}/review`} className={`${secondaryButtonClass} inline-flex min-h-9 items-center border-[var(--color-warning,#f59e0b)]`}>
            {canManage ? t("detail.reviewDraft", { n: draft.changed_tables?.length ?? 0 }) : t("detail.seeDraft", { n: draft.changed_tables?.length ?? 0 })}
          </Link>
        ) : null}
        {canPropose ? (
          <Link
            href={`/chat?new=1&draft=${encodeURIComponent(buildPrompt)}`}
            title={t("build.hint")}
            className={`${secondaryButtonClass} inline-flex min-h-9 items-center`}
          >
            {t("build.label")}
          </Link>
        ) : null}
        {canManage ? (
          <button type="button" className={`${secondaryButtonClass} min-h-9`} onClick={() => setSharing(true)}>
            {t("share.open")}
          </button>
        ) : null}
      </div>

      {tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center">
          <p className="font-medium">{t("detail.emptyTitle")}</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{canPropose ? t("detail.emptyBody") : t("detail.emptyBodyRead")}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <label className="lg:hidden">
            <span className="sr-only">{t("detail.table")}</span>
            <select className={inputClass} value={picked} onChange={(e) => setPicked(e.target.value)}>
              {tables.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <ul aria-label={t("detail.tables")} className="hidden flex-col gap-1 self-start rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 lg:flex">
            {tables.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-current={picked === name}
                  onClick={() => setPicked(name)}
                  className={`w-full truncate rounded-[var(--radius-md)] px-3 py-2 text-left text-sm ${
                    picked === name ? "bg-[var(--color-surface-2)] font-medium text-[var(--color-fg)]" : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {entry ? (
            <section data-component="DictionaryEntry" className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-lg font-semibold">{picked}</h2>
                {canPropose ? (
                  <button type="button" className={secondaryButtonClass} onClick={() => setEditing(picked)}>
                    {t("detail.edit")}
                  </button>
                ) : null}
              </div>
              <dl className="flex flex-col gap-4">
                <Field label={t("field.meaning")}>{entry.meaning || "—"}</Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("field.row")}>{entry.row || "—"}</Field>
                  <Field label={t("field.grain")}>{entry.grain || "—"}</Field>
                </div>
                <Field label={t("field.columns")}>
                  {Object.keys(entry.columns).length ? (
                    <ul className="flex flex-col gap-1">
                      {Object.entries(entry.columns).map(([c, d]) => (
                        <li key={c}>
                          <code className="text-[var(--color-accent)]">{c}</code> {d ? `— ${d}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "—"
                  )}
                </Field>
                {entry.joins.length ? (
                  <Field label={t("field.joins")}>
                    <ul className="flex flex-col gap-1">{entry.joins.map((j, i) => <li key={i}>{`→ ${j.to}${j.on ? ` (${j.on})` : ""}${j.note ? ` — ${j.note}` : ""}`}</li>)}</ul>
                  </Field>
                ) : null}
                {entry.metrics.length ? (
                  <Field label={t("field.metrics")}>
                    <ul className="flex flex-col gap-1">{entry.metrics.map((m, i) => <li key={i}><strong>{m.name}</strong> — {m.definition}</li>)}</ul>
                  </Field>
                ) : null}
                {entry.examples.length ? (
                  <Field label={t("field.examples")}>
                    <ul className="flex flex-col gap-2">
                      {entry.examples.map((x, i) => (
                        <li key={i}>
                          <p>{x.question}</p>
                          {x.sql ? <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--color-surface-2)] p-2 text-xs">{x.sql}</pre> : null}
                        </li>
                      ))}
                    </ul>
                  </Field>
                ) : null}
              </dl>
            </section>
          ) : null}
        </div>
      )}

      <section aria-labelledby="dd-history" className="flex flex-col gap-2">
        <h2 id="dd-history" className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("history.title")}
        </h2>
        <ul data-component="DictionaryHistory" className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {versions.length === 0 ? <li className="px-4 py-3 text-sm text-[var(--color-muted)]">{t("history.empty")}</li> : null}
          {versions.map((v) => (
            <li key={v.version} data-version={v.version} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <span className="font-medium">v{v.version}</span>
              <Pill tone={v.status === "approved" ? "success" : v.status === "draft" ? "warning" : "muted"}>{t(`history.status.${v.status}`)}</Pill>
              <span className="min-w-0 flex-1 text-[var(--color-muted)] [overflow-wrap:anywhere]">
                {t("history.line", {
                  who: personName(people, v.approved_by ?? v.proposed_by),
                  when: formatWhen(v.approved_at ?? v.proposed_at, locale),
                  n: v.changes.length,
                })}
              </span>
              {canManage && v.status === "superseded" && !draft ? (
                <button type="button" className={secondaryButtonClass} onClick={() => setRestoring(v.version)}>
                  {t("history.restore")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage && draft ? <p className="text-xs text-[var(--color-muted)]">{t("history.restoreBlocked")}</p> : null}
      </section>

      {editing ? (
        <EditSheet
          sourceId={source.id}
          table={editing}
          entry={entryOf(draft?.entries ?? approved?.entries, editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
      {sharing ? <ShareSheet sourceId={source.id} ownerId={source.owner_user_id} directory={directory} onClose={() => setSharing(false)} /> : null}
      {restoring !== null ? (
        <ConfirmDialog
          title={t("history.restoreTitle", { v: restoring })}
          body={t("history.restoreBody")}
          confirmLabel={t("history.restore")}
          onConfirm={() => restore(restoring)}
          onCancel={() => setRestoring(null)}
        />
      ) : null}
    </div>
  );
}

/** Edit one table: the change goes into the draft; the owner approves it. */
export function EditSheet({
  sourceId,
  table,
  entry,
  onClose,
  onSaved,
}: {
  sourceId: string;
  table: string;
  entry: DictionaryEntry;
  onClose(): void;
  onSaved(): void;
}) {
  const t = useT("data");
  const [meaning, setMeaning] = useState(entry.meaning);
  const [row, setRow] = useState(entry.row);
  const [grain, setGrain] = useState(entry.grain);
  const [columns, setColumns] = useState(columnsToText(entry.columns));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await readJson(
        await fetch(dataPath(sourceId, "draft"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tables: { [table]: { ...entry, meaning, row, grain, columns: textToColumns(columns) } }, note }),
        }),
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Sheet
      title={t("edit.title", { table })}
      onClose={onClose}
      component="DictionaryEditSheet"
      mobileFull
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {t("edit.cancel")}
          </button>
          <ActionButton className={primaryButtonClass} busyLabel={t("edit.saving")} onAction={save}>
            {t("edit.save")}
          </ActionButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <InlineAlert tone="info">{t("edit.hint")}</InlineAlert>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <label className="flex flex-col gap-1">
          {t("field.meaning")}
          <textarea className={inputClass} rows={3} value={meaning} onChange={(e) => setMeaning(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          {t("field.row")}
          <input className={inputClass} value={row} onChange={(e) => setRow(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          {t("field.grain")}
          <input className={inputClass} value={grain} onChange={(e) => setGrain(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          {t("field.columns")}
          <textarea className={`${inputClass} font-mono`} rows={6} value={columns} onChange={(e) => setColumns(e.target.value)} />
          <span className="text-xs text-[var(--color-muted)]">{t("edit.columnsHint")}</span>
        </label>
        <label className="flex flex-col gap-1">
          {t("edit.note")}
          <input className={inputClass} value={note} placeholder={t("edit.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}
