"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/Sheet";
import { JSON_HEADERS, personName, readJson } from "@/components/sites/format";
import { useT } from "@/i18n";
import type { DirectoryEntry } from "@/types";
import type { DataSourceDoc } from "@/types/data";

import { allows, dataPath, fieldDiff } from "./format";

/**
 * Figma "Review draft": each changed table shows current vs proposed text and
 * where the change came from; accept or reject each, then Approve (pinned on
 * phones) saves the new version. Proposers see it read-only.
 */
export function ReviewDraft({ doc, directory }: { doc: DataSourceDoc; directory: DirectoryEntry[] }) {
  const t = useT("data");
  const router = useRouter();
  const { source, approved, draft } = doc;
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const people = Object.fromEntries(directory.map((p) => [p.user_id, p.display || p.user_id]));
  const canManage = allows(source.access, "manage");

  if (!draft) {
    return (
      <div data-component="ReviewDraft" className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-center">
        <p className="font-medium">{t("review.noneTitle")}</p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{t("review.noneBody")}</p>
      </div>
    );
  }
  const changed = draft.changed_tables ?? [];
  const accepted = changed.filter((c) => !rejected.has(c)).length;

  function toggle(table: string, accept: boolean) {
    setRejected((prev) => {
      const next = new Set(prev);
      if (accept) next.delete(table);
      else next.add(table);
      return next;
    });
  }

  async function approve() {
    setError(null);
    try {
      await readJson(
        await fetch(dataPath(source.id, "draft", "approve"), {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ version: draft!.version, reject: [...rejected] }),
        }),
      );
      router.push(`/data/${source.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function discard() {
    setError(null);
    try {
      await readJson(await fetch(dataPath(source.id, "draft"), { method: "DELETE" }));
      router.push(`/data/${source.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiscarding(false);
    }
  }

  return (
    <div data-component="ReviewDraft" className="flex flex-col gap-4 pb-44 lg:pb-8">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <InlineAlert tone="info">{canManage ? t("review.hint") : t("review.hintRead")}</InlineAlert>
      {changed.map((table) => {
        const before = approved?.entries?.tables?.[table] ?? null;
        const after = draft.entries?.tables?.[table] ?? null;
        const sources = draft.changes.filter((c) => c.table === table || c.table === `-${table}`);
        const isRejected = rejected.has(table);
        return (
          <section key={table} data-table={table} className={`flex flex-col gap-3 rounded-2xl border bg-[var(--color-surface)] p-4 ${isRejected ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-accent)]"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-semibold">{table}</h2>
              <Pill tone={!before ? "accent" : !after ? "danger" : "warning"}>{t(!before ? "review.new" : !after ? "review.removed" : "review.changed")}</Pill>
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {sources.map((c) => t("review.from", { origin: t(`origin.${c.origin}`), who: personName(people, c.by) }) + (c.note ? ` — ${c.note}` : "")).join(" · ")}
            </p>
            <div className="flex flex-col gap-2">
              {fieldDiff(before, after).map((d) => (
                <div key={d.field} className="grid gap-2 text-sm md:grid-cols-2">
                  <div className="rounded-lg bg-[var(--color-surface-2)] p-2">
                    <p className="text-xs text-[var(--color-muted)]">{t(`field.${d.field}`)} · {t("review.current")}</p>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.from || "—"}</p>
                  </div>
                  <div className="rounded-lg border border-[var(--color-accent)]/40 p-2">
                    <p className="text-xs text-[var(--color-muted)]">{t(`field.${d.field}`)} · {t("review.proposed")}</p>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.to || "—"}</p>
                  </div>
                </div>
              ))}
            </div>
            {canManage ? (
              <div role="group" aria-label={t("review.decide", { table })} className="flex gap-2">
                <button type="button" aria-pressed={!isRejected} className={!isRejected ? primaryButtonClass : secondaryButtonClass} onClick={() => toggle(table, true)}>
                  {t("review.accept")}
                </button>
                <button type="button" aria-pressed={isRejected} className={isRejected ? primaryButtonClass : secondaryButtonClass} onClick={() => toggle(table, false)}>
                  {t("review.reject")}
                </button>
              </div>
            ) : null}
          </section>
        );
      })}
      {canManage ? (
        <div
          data-component="ApproveBar"
          className="fixed inset-x-3 bottom-[calc(var(--safe-bottom,0px)+4.75rem)] z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-lg lg:static lg:shadow-none"
        >
          <span className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">{t("review.summary", { accepted, total: changed.length })}</span>
          <button type="button" className={secondaryButtonClass} onClick={() => setDiscarding(true)}>
            {t("review.discard")}
          </button>
          <ActionButton className={primaryButtonClass} busyLabel={t("review.approving")} onAction={approve}>
            {accepted ? t("review.approve", { v: draft.version }) : t("review.rejectAll")}
          </ActionButton>
        </div>
      ) : null}
      {discarding ? (
        <ConfirmDialog
          title={t("review.discardTitle")}
          body={t("review.discardBody")}
          confirmLabel={t("review.discard")}
          onConfirm={discard}
          onCancel={() => setDiscarding(false)}
        />
      ) : null}
    </div>
  );
}
