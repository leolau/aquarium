"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { DiffPreview, IMPROVE_SEED_START } from "@/components/skills/SkillImprovePanel";
import { accentChipClass, toolButtonClass } from "@/components/skills/SkillPage";
import { skillHref } from "@/components/skills/skill-links";
import { useLabChat } from "@/components/skills/useLabChat";
import { ActionButton } from "@/components/ui/ActionButton";
import { PlusIcon, SparklesIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/client";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import { diffLines } from "@/lib/skills/diff";
import {
  evidenceReference,
  evidenceStatus,
  evidenceTitle,
  nextVersionNumber,
  shortDate,
  stripDraft,
  versionLabel,
  type SkillUsageDetail,
  type SkillUsageEvent,
  type SkillVersionList,
  type SkillVersionMeta,
} from "@/lib/skills/improve";

/** One skill row of the project Skills tab (the per-row "Improve with AI" target). */
export interface ImproveSkillTarget {
  name: string;
  profile: string;
}

const RUNS = 20;
const TONE: Record<ReturnType<typeof evidenceStatus>["tone"], string> = {
  danger: "text-[var(--color-danger)]",
  warn: "text-[var(--color-warn-text)]",
  success: "text-[var(--color-success)]",
  muted: "text-[var(--color-muted)]",
};
const mobileButton = "min-h-11 sm:min-h-9";

/**
 * Projects → Skills "Improve with AI": the Skills Lab improve chat, scoped to
 * one project. That project's card runs are the primary evidence; the agent
 * also gets a numeric summary of the skill's other uses (server-side seed).
 * A proposal is saved as a draft version; the live skill never changes here.
 */
export function ImproveSkillSheet({
  project,
  skill,
  onClose,
}: {
  project: { slug: string; name: string };
  skill: ImproveSkillTarget;
  onClose(): void;
}) {
  const t = useT("projects");
  const { name, profile } = skill;
  const q = profileQuery(profile);
  const scoped = useMemo(() => (q ? { profile } : {}), [q, profile]);
  const enc = encodeURIComponent(name);
  const withQ = (path: string) => (q ? `${path}&${q}` : path);

  const [versions, setVersions] = useState<SkillVersionList | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [runs, setRuns] = useState<{ events: SkillUsageEvent[] } | { error: string } | null>(null);
  const [reloadRuns, setReloadRuns] = useState(0);
  const [fullDiffRev, setFullDiffRev] = useState<number | null>(null);

  const versionsUrl = withQ(`/api/skills/versions?name=${enc}`);
  const contentUrl = withQ(`/api/skills/content?name=${enc}`);
  const runsUrl = withQ(`/api/skills/usage/detail?name=${enc}&project=${encodeURIComponent(project.slug)}&days=90&limit=${RUNS}`);

  useEffect(() => {
    let live = true;
    void getJson<SkillVersionList>(versionsUrl).then((v) => live && setVersions(v), () => undefined);
    void getJson<{ content: string }>(contentUrl).then((c) => live && setBaseline(c.content ?? ""), () => live && setBaseline(""));
    return () => {
      live = false;
    };
  }, [versionsUrl, contentUrl]);

  useEffect(() => {
    let live = true;
    getJson<SkillUsageDetail>(runsUrl).then(
      // Older backends ignore `?project=`; keep only this project's runs either way.
      (d) => live && setRuns({ events: (d.events ?? []).filter((e) => e.project?.slug === project.slug) }),
      (err) => live && setRuns({ error: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [runsUrl, project.slug, reloadRuns]);

  const chat = useLabChat<SkillVersionMeta>({
    startUrl: "/api/skills/improve/start",
    startBody: (goal) => ({ name, project: project.slug, ...(goal ? { goal } : {}), ...scoped }),
    messageUrl: "/api/skills/improve/message",
    messageBody: scoped,
    transcriptQuery: q,
    seedStart: IMPROVE_SEED_START,
    save: async (draft, sessionId) => {
      const meta = await sendJson<SkillVersionMeta>("/api/skills/versions/draft", "POST", {
        name,
        content: draft,
        message: t("skillImprove.draftMessage", { project: project.name }),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...scoped,
      });
      void getJson<SkillVersionList>(versionsUrl).then(setVersions, () => undefined);
      return meta;
    },
  });
  const { turns, draft, saved, sendError, notice, text, setText, composerRef, send, save } = chat;

  const active = versionLabel(versions, versions?.active ?? null);
  const nextN = versions ? nextVersionNumber(versions.versions) : null;
  const ops = useMemo(
    () => (draft === null || baseline === null ? [] : diffLines(baseline.replace(/\s+$/, ""), draft.replace(/\s+$/, ""))),
    [baseline, draft],
  );
  const changed = ops.filter((o) => o.type !== "same");
  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;
  const fullDiff = fullDiffRev === chat.draftRev;
  const versionsHref = skillHref(name, profile, "", "tab=versions");
  const labHref = skillHref(name, profile, "", `tab=improve&project=${encodeURIComponent(project.slug)}`);

  const composer = (
    <div className="flex w-full items-end gap-2">
      <label className="sr-only" htmlFor="improve-sheet-composer">
        {t("skillImprove.composerLabel")}
      </label>
      <textarea
        id="improve-sheet-composer"
        ref={composerRef}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send.run(text);
          }
        }}
        placeholder={t("skillImprove.placeholder")}
        className="max-h-40 min-h-11 flex-1 resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      <button
        type="button"
        disabled={send.pending || !text.trim()}
        onClick={() => void send.run(text)}
        className={`${mobileButton} rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60`}
      >
        {send.pending ? t("skillImprove.sending") : t("skillImprove.send")}
      </button>
    </div>
  );

  return (
    <Sheet
      title={t("skillImprove.sheetTitle", { name })}
      onClose={onClose}
      full
      mobileFull
      component="ImproveSkillSheet"
      footer={composer}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
            {t("skillImprove.sheetSubtitle", {
              version: active ? t("skillImprove.currentVersion", { version: active }) : t("skillImprove.liveVersion"),
              profile,
            })}
          </p>
          <Link href={labHref} className={`${toolButtonClass} ${mobileButton} inline-flex items-center`}>
            {t("skillImprove.openLab")}
          </Link>
        </div>

        <section aria-label={t("skillImprove.projectRuns")} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={accentChipClass}>{t("skillImprove.evidenceChip", { name: project.name })}</span>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{t("skillImprove.projectRuns")}</h3>
          </div>
          {runs === null ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Spinner /> {t("skillImprove.loadingRuns")}
            </p>
          ) : "error" in runs ? (
            <InlineAlert
              tone="danger"
              action={
                <button type="button" className={`${toolButtonClass} ${mobileButton}`} onClick={() => setReloadRuns((n) => n + 1)}>
                  {t("skillImprove.retry")}
                </button>
              }
            >
              {t("skillImprove.runsError")} {runs.error}
            </InlineAlert>
          ) : runs.events.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{t("skillImprove.noRuns")}</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-1.5">
                {runs.events.map((e) => {
                  const status = evidenceStatus(e);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => chat.insert(evidenceReference(e, versions))}
                        className={`${mobileButton} inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 text-left text-xs hover:border-[var(--color-accent)]`}
                      >
                        <span className="truncate">{evidenceTitle(e).title}</span>
                        <span className={`shrink-0 font-semibold ${TONE[status.tone]}`}>{status.label}</span>
                        <span className="shrink-0 text-[var(--color-muted)]">{shortDate(e.ts)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-[var(--color-muted)]">{t("skillImprove.projectRunsHint")}</p>
            </>
          )}
          <p className="mt-2 text-xs text-[var(--color-muted)]">{t("skillImprove.elsewhereNote")}</p>
        </section>

        {notice ? <InlineAlert tone="danger">{notice}</InlineAlert> : null}

        <div aria-live="polite" className="flex flex-col gap-2.5">
          {chat.transcript === "loading" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Spinner /> {t("skillImprove.loadingChat")}
            </p>
          ) : null}
          {turns.length === 0 && !send.pending ? <p className="text-sm text-[var(--color-muted)]">{t("skillImprove.emptyChat")}</p> : null}
          {turns.map((m, i) => (
            <MessageBubble
              key={m.clientKey ?? m.id ?? i}
              message={{ ...m, content: m.role === "assistant" ? stripDraft(m.content ?? "") || t("skillImprove.proposed") : m.content }}
              msgIndex={i}
            />
          ))}
          {send.pending ? (
            <p role="status" className="flex items-center gap-2 self-start rounded-2xl bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]">
              <Spinner /> {t("skillImprove.thinking")}
            </p>
          ) : null}
          {sendError ? (
            <InlineAlert
              tone="danger"
              title={t("skillImprove.sendFailed")}
              action={
                <button type="button" className={`${toolButtonClass} ${mobileButton}`} disabled={send.pending} onClick={() => void send.run(sendError.text)}>
                  {t("skillImprove.retry")}
                </button>
              }
            >
              {sendError.message}
            </InlineAlert>
          ) : null}
        </div>

        {draft !== null ? (
          <section
            data-component="ProposedSkillDraft"
            aria-label={t("skillImprove.proposed")}
            className="rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <SparklesIcon size={16} className="text-[var(--color-accent)]" />
              <h3 className="text-sm font-semibold">{t("skillImprove.proposed")}</h3>
              <span className={accentChipClass}>
                {added || removed ? t("skillImprove.changes", { added, removed }) : t("skillImprove.noChanges")}
              </span>
            </div>
            <DiffPreview ops={ops} changed={changed} full={fullDiff} />
            {saved ? (
              <InlineAlert
                tone="success"
                className="mt-2.5"
                action={
                  <Link href={versionsHref} className={`${toolButtonClass} ${mobileButton} inline-flex items-center`}>
                    {t("skillImprove.openVersions")}
                  </Link>
                }
              >
                {t("skillImprove.saved", { n: saved.n })}
              </InlineAlert>
            ) : (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <ActionButton
                  onAction={() => save.run()}
                  busy={save.pending}
                  busyLabel={t("skillImprove.saving")}
                  className={`${mobileButton} inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60`}
                >
                  <PlusIcon size={14} /> {nextN ? t("skillImprove.saveDraft", { n: nextN }) : t("skillImprove.saveDraftPlain")}
                </ActionButton>
                <button type="button" className={`${toolButtonClass} ${mobileButton}`} aria-expanded={fullDiff} onClick={() => setFullDiffRev(fullDiff ? null : chat.draftRev)}>
                  {fullDiff ? t("skillImprove.changesOnly") : t("skillImprove.fullDiff")}
                </button>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
