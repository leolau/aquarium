"use client";

import Link from "next/link";
import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Pill } from "@/components/ui/Pill";
import { useRefresh } from "@/components/ui/useRefresh";
import { useLocale, useT } from "@/i18n";
import type { SiteDesign } from "@/types/sites";

import { designEntities, entityChange, formatWhen, personName, pickDesigns, readJson, sitePath } from "./format";

/**
 * Design approval: what the agent proposes to store, entity by entity, and the
 * one Approve that applies it (additive changes only; nothing is dropped).
 */
export function DesignTab({
  siteId,
  designs,
  canManage,
  people,
}: {
  siteId: string;
  designs: SiteDesign[];
  canManage: boolean;
  people: Record<string, string>;
}) {
  const t = useT("sites");
  const locale = useLocale();
  const { refresh } = useRefresh();
  const { approved, proposed } = pickDesigns(designs);
  const [showApproved, setShowApproved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ version: number; statements: string[] } | null>(null);

  const shown = showApproved || !proposed ? approved : proposed;
  if (!shown) {
    return (
      <div data-component="DesignTab" className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm">
        <p className="font-medium">{t("design.noneTitle")}</p>
        <p className="mt-1 text-[var(--color-muted)]">{t("design.noneBody")}</p>
      </div>
    );
  }
  const entities = designEntities(shown);
  const before = shown === proposed && approved ? designEntities(approved) : null;
  const questions = entities.filter((e) => e.question);
  const isProposal = shown === proposed;

  async function approve() {
    setError(null);
    try {
      const res = await readJson<{ version: number; statements: string[] }>(
        await fetch(sitePath(siteId, "designs", String(proposed!.version), "approve"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      setApplied(res);
      setConfirming(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirming(false);
    }
  }

  return (
    <div data-component="DesignTab" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("design.version", { version: shown.version })}</span>
            <Pill tone={isProposal ? "warning" : "success"}>{t(`designStatus.${shown.status}`)}</Pill>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            {isProposal
              ? t("design.proposedBy", {
                  who: personName(people, shown.proposed_by),
                  when: formatWhen(shown.proposed_at, locale),
                })
              : t("design.approvedBy", {
                  who: personName(people, shown.approved_by),
                  when: formatWhen(shown.approved_at, locale),
                })}
          </p>
        </div>
        {proposed && approved ? (
          <button
            type="button"
            className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs"
            onClick={() => setShowApproved((v) => !v)}
          >
            {showApproved ? t("design.showProposal", { version: proposed.version }) : t("design.showApproved", { version: approved.version })}
          </button>
        ) : null}
        {isProposal && canManage ? (
          <ActionButton
            onAction={() => setConfirming(true)}
            className="rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            {t("design.approve")}
          </ActionButton>
        ) : null}
      </div>

      {applied ? (
        <InlineAlert tone="success" title={t("design.appliedTitle", { version: applied.version })}>
          {t("design.appliedBody", { count: applied.statements.length })}
        </InlineAlert>
      ) : null}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {isProposal && !canManage ? <InlineAlert tone="info">{t("design.readOnly")}</InlineAlert> : null}

      {isProposal && questions.length ? (
        <InlineAlert
          tone="warn"
          title={t("design.questionsTitle", { count: questions.length })}
          action={
            <Link href="/chat" className="text-xs underline">
              {t("design.answerInChat")}
            </Link>
          }
        >
          <ul className="list-disc space-y-1 pl-4">
            {questions.map((e) => (
              <li key={e.name}>
                <span className="font-mono text-xs">{e.name}</span>: {e.question}
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}

      <ul className="space-y-3">
        {entities.map((e) => {
          const change = entityChange(e, before);
          return (
            <li
              key={e.name}
              data-entity={e.name}
              className="space-y-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{e.name}</span>
                <Pill tone={e.kind === "fixed" ? "accent" : "muted"}>{t(`kind.${e.kind}`)}</Pill>
                <Pill>{t(`mode.${e.refresh.mode === "full" ? "full" : "incremental"}`)}</Pill>
                {change.kind === "new" ? <Pill tone="success">{t("design.newTable")}</Pill> : null}
                {change.kind === "columns" ? (
                  <Pill tone="success">{t("design.newColumns", { count: change.added.length })}</Pill>
                ) : null}
              </div>
              {e.reason ? (
                <p className="text-sm">
                  <span className="text-[var(--color-muted)]">{t("design.why")} </span>
                  {e.reason}
                </p>
              ) : null}
              <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-[var(--color-muted)]">{t("design.key")}</dt>
                <dd className="font-mono">{e.key.join(", ") || "—"}</dd>
                {e.source ? (
                  <>
                    <dt className="text-[var(--color-muted)]">{t("design.source")}</dt>
                    <dd className="break-all font-mono">{e.source}</dd>
                  </>
                ) : null}
                <dt className="text-[var(--color-muted)]">{t("design.refresh")}</dt>
                <dd>
                  {t(`mode.${e.refresh.mode === "full" ? "full" : "incremental"}`)}
                  {e.refresh.cursor ? ` · ${t("design.cursor", { cursor: e.refresh.cursor })}` : ""}
                  {e.refresh.full_every ? ` · ${t("design.fullEvery", { every: e.refresh.full_every })}` : ""}
                </dd>
              </dl>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[var(--color-muted)]">
                    <tr>
                      <th className="py-1 pr-3 font-normal">{t("design.column")}</th>
                      <th className="py-1 pr-3 font-normal">{t("design.type")}</th>
                      <th className="py-1 font-normal">{t("design.example")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.columns.map((c) => (
                      <tr key={c.name} className="border-t border-[var(--color-border)]">
                        <td className="py-1 pr-3 font-mono">
                          {c.name}
                          {e.key.includes(c.name) ? <span className="ml-1 text-[var(--color-accent)]">{t("design.keyMark")}</span> : null}
                          {change.kind === "columns" && change.added.includes(c.name) ? (
                            <span className="ml-1 text-[var(--color-success)]">{t("design.newMark")}</span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-3 font-mono">{c.type}</td>
                        <td className="py-1 text-[var(--color-muted)]">
                          {c.example === undefined || c.example === null ? "" : String(c.example)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {e.question && isProposal ? (
                <p className="rounded-lg bg-[var(--color-surface-2)] p-2 text-xs">
                  <span className="font-medium">{t("design.agentAsks")} </span>
                  {e.question}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {confirming && proposed ? (
        <ConfirmDialog
          tone="accent"
          title={t("design.confirmTitle", { version: proposed.version })}
          body={questions.length ? t("design.confirmBodyQuestions", { count: questions.length }) : t("design.confirmBody")}
          confirmLabel={t("design.approve")}
          onConfirm={approve}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
