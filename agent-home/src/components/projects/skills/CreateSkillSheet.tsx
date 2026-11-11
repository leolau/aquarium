"use client";

/**
 * Projects › Skills › "New skill with AI" (plan Part B, Appendix B §3.5).
 * Describe the goal, tick the cards to learn from, let the agent draft a
 * SKILL.md, refine it in chat, then save it as a **disabled draft** (D7):
 * it is enabled from the skill's Versions tab. A lead can also preload it in
 * this project's runs (existing `PATCH /tools`).
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { skillHref } from "@/components/skills/skill-links";
import { useLabChat } from "@/components/skills/useLabChat";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Sheet, inputClass } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n";
import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import { stripDraft } from "@/lib/skills/improve";
import { useAction } from "@/lib/use-action";
import {
  CREATE_SEED_START,
  draftSkillName,
  isValidSkillName,
  type CreatedSkill,
  type SkillCandidateRef,
} from "@/lib/skills/create";
import type { ProjectBoardTask, ProjectBoardView } from "@/types";

export const MAX_CREATE_CARDS = 12;
const DEFAULT_PICKS = 5;
const btn = "inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-medium disabled:opacity-60 sm:min-h-9";
const primary = `${btn} bg-[var(--color-accent)] text-[var(--color-accent-fg)]`;
const secondary = `${btn} border border-[var(--color-border)]`;
const label = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";
const card = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3";

export interface CreateSkillSheetProps {
  slug: string;
  projectName?: string;
  /** The profile the skill is written in (one of the project's profiles). */
  profile: string;
  /** A retro suggestion to start from (Skills tab "Create with AI"). */
  candidate?: SkillCandidateRef | null;
  /** Cards to offer; read from the project board when omitted. */
  cards?: ProjectBoardTask[];
  /** Lead/owner/admin: offer "Preload in this project's runs". */
  canPreload?: boolean;
  /** The project's current preloaded skills (kept when preloading). */
  preloaded?: string[];
  onClose(): void;
  onCreated?(skill: CreatedSkill): void;
}

/** The project's finished cards, newest first. */
export function doneCards(view: ProjectBoardView): ProjectBoardTask[] {
  return view.columns
    .flatMap((c) => c.tasks)
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completed_at ?? b.created_at) - (a.completed_at ?? a.created_at));
}

export function CreateSkillSheet({
  slug,
  projectName,
  profile,
  candidate = null,
  cards: givenCards,
  canPreload = false,
  preloaded = [],
  onClose,
  onCreated,
}: CreateSkillSheetProps) {
  const t = useT("projects");
  const [goal, setGoal] = useState("");
  const [cards, setCards] = useState<ProjectBoardTask[] | null>(givenCards ?? null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [pickedSet, setPicked] = useState<Set<string> | null>(null);
  const [typedName, setName] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [preload, setPreload] = useState<"idle" | "done" | string>("idle");

  useEffect(() => {
    if (givenCards) return;
    let live = true;
    getJson<ProjectBoardView>(`/api/projects/${encodeURIComponent(slug)}/board`)
      .then((view) => live && setCards(doneCards(view).slice(0, MAX_CREATE_CARDS)))
      .catch((err) => live && setCardsError(errorText(err)));
    return () => {
      live = false;
    };
  }, [givenCards, slug]);

  const picked = useMemo(
    () => pickedSet ?? new Set((cards ?? []).slice(0, DEFAULT_PICKS).map((c) => c.id)),
    [pickedSet, cards],
  );
  const chat = useLabChat<CreatedSkill>({
    startUrl: "/api/skills/create/start",
    startBody: (g) => ({
      profile,
      project: slug,
      ...(g ? { goal: g } : {}),
      ...(candidate ? { candidate_id: candidate.id } : {}),
      card_ids: [...picked],
    }),
    messageUrl: "/api/skills/create/message",
    messageBody: { profile },
    transcriptQuery: `profile=${encodeURIComponent(profile)}`,
    seedStart: CREATE_SEED_START,
    save: async (content: string, sessionId: string | null): Promise<CreatedSkill> => {
      const res: CreatedSkill = await sendJson<CreatedSkill>("/api/skills/create/save", "POST", {
        profile,
        project: slug,
        name,
        content,
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(candidate ? { candidate_id: candidate.id } : {}),
      });
      onCreated?.(res);
      return res;
    },
  });
  const { draft, saved, turns, send, text, setText, composerRef } = chat;
  const name: string = typedName ?? (draft ? draftSkillName(draft) : null) ?? "";

  const started = chat.sessionId !== null;
  const canDraft = Boolean(goal.trim() || candidate || picked.size);

  const drafting = useAction(async () => {
    if (!canDraft) return;
    if (await chat.start.run(goal)) await send.run(goal.trim() || t("createSkill.firstTurn"));
  });

  const preloadIt = useAction(async () => {
    if (!saved) return;
    setPreload("idle");
    try {
      const skills = [...preloaded.filter((s) => s !== saved.name), saved.name];
      await sendJson(`/api/projects/${encodeURIComponent(slug)}/tools`, "PATCH", { skills });
      setPreload("done");
    } catch (err) {
      setPreload(errorText(err));
    }
  });

  function submitGoal(e: FormEvent) {
    e.preventDefault();
    void drafting.run();
  }

  function submitMessage(e: FormEvent) {
    e.preventDefault();
    void send.run(text);
  }

  const toggle = (id: string) =>
    setPicked(() => {
      const next = new Set(picked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const footer = saved ? (
    <>
      <Link href={skillHref(saved.name, profile, "", "tab=versions")} className={primary}>
        {t("createSkill.enableFromVersions")}
      </Link>
      <button type="button" className={secondary} onClick={onClose}>
        {t("createSkill.done")}
      </button>
    </>
  ) : started ? (
    <>
      <ActionButton
        className={primary}
        disabled={!draft || !isValidSkillName(name)}
        busy={chat.save.pending}
        busyLabel={t("createSkill.saving")}
        onAction={() => chat.save.run()}
      >
        {t("createSkill.saveDraft")}
      </ActionButton>
      <button type="button" className={secondary} onClick={onClose}>
        {t("createSkill.cancel")}
      </button>
    </>
  ) : (
    <>
      <ActionButton type="submit" form="create-skill-goal" className={primary} disabled={!canDraft} busy={drafting.pending} busyLabel={t("createSkill.drafting")}>
        {t("createSkill.draftIt")}
      </ActionButton>
      <button type="button" className={secondary} onClick={onClose}>
        {t("createSkill.cancel")}
      </button>
    </>
  );

  return (
    <Sheet title={t("createSkill.title")} onClose={onClose} wide full footer={footer} component="CreateSkillSheet">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-xs text-[var(--color-muted)]">
          {t("createSkill.context", { project: projectName || slug, profile })}
        </p>

        {saved ? (
          <section className={card} aria-live="polite">
            <h3 className="font-semibold">{t("createSkill.savedTitle", { name: saved.name })}</h3>
            <p className="mt-1 text-[var(--color-muted)]">{t("createSkill.savedBody")}</p>
            {canPreload ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {preload === "done" ? (
                  <span className="text-[var(--color-success)]">{t("createSkill.preloaded")}</span>
                ) : (
                  <ActionButton className={secondary} onAction={() => preloadIt.run()}>
                    {t("createSkill.preload")}
                  </ActionButton>
                )}
                {preload !== "idle" && preload !== "done" ? (
                  <InlineAlert tone="danger">{preload}</InlineAlert>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {!started ? (
          <form id="create-skill-goal" onSubmit={submitGoal} className="flex flex-col gap-4">
            {candidate ? (
              <section className={card}>
                <div className={label}>{t("createSkill.fromRetro")}</div>
                <div className="font-medium">{candidate.name}</div>
                {candidate.body ? <p className="mt-1 whitespace-pre-wrap text-[var(--color-muted)]">{candidate.body}</p> : null}
              </section>
            ) : null}
            <label>
              <span className={label}>{t("createSkill.goalLabel")}</span>
              <textarea
                className={`${inputClass} min-h-24`}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t("createSkill.goalPlaceholder")}
              />
            </label>
            <fieldset>
              <legend className={label}>{t("createSkill.cardsLabel")}</legend>
              {cardsError ? (
                <InlineAlert tone="danger">{cardsError}</InlineAlert>
              ) : cards === null ? (
                <p className="flex items-center gap-2 text-[var(--color-muted)]"><Spinner />{t("createSkill.loadingCards")}</p>
              ) : cards.length === 0 ? (
                <p className="text-[var(--color-muted)]">{t("createSkill.noCards")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {cards.map((c) => (
                    <li key={c.id}>
                      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 sm:min-h-0">
                        <input type="checkbox" className="mt-1" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                        <span className="min-w-0">
                          <span className="font-medium">
                            {c.ref ? <span className="mr-1.5 text-[var(--color-muted)]">{c.ref}</span> : null}
                            {c.title}
                          </span>
                          {c.result ? <span className="block truncate text-xs text-[var(--color-muted)]">{c.result}</span> : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <p className="text-xs text-[var(--color-muted)]">{t("createSkill.draftNote")}</p>
          </form>
        ) : null}

        {started && !saved ? (
          <>
            <section aria-label={t("createSkill.chatLabel")} className="flex flex-col gap-2">
              {turns.map((m, i) =>
                m.content ? (
                  <div
                    key={m.clientKey ?? m.id ?? i}
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 ${
                      m.role === "user" ? "self-end bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "self-start bg-[var(--color-surface-2)]"
                    }`}
                  >
                    {m.role === "assistant" ? stripDraft(m.content) || t("createSkill.draftLabel") : m.content}
                  </div>
                ) : null,
              )}
              {send.pending ? <p className="flex items-center gap-2 text-[var(--color-muted)]"><Spinner />{t("createSkill.thinking")}</p> : null}
            </section>

            {draft ? (
              <section className={card} aria-label={t("createSkill.draftLabel")}>
                <div className="mb-2 flex flex-wrap items-end gap-2">
                  <label className="min-w-40 flex-1">
                    <span className={label}>{t("createSkill.nameLabel")}</span>
                    <input
                      className={inputClass}
                      value={name}
                      onChange={(e) => setName(e.target.value.trim())}
                      aria-invalid={!isValidSkillName(name)}
                    />
                  </label>
                  <label className="min-w-32 flex-1">
                    <span className={label}>{t("createSkill.categoryLabel")}</span>
                    <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("createSkill.categoryPlaceholder")} />
                  </label>
                  <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
                    {t("createSkill.draftBadge")}
                  </span>
                </div>
                {!isValidSkillName(name) ? <p className="mb-2 text-xs text-[var(--color-danger)]">{t("createSkill.nameInvalid")}</p> : null}
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--color-surface-2)] p-3 font-mono text-xs">{draft}</pre>
              </section>
            ) : null}

            <form onSubmit={submitMessage} className="flex items-end gap-2">
              <textarea
                ref={composerRef}
                aria-label={t("createSkill.messageLabel")}
                className={`${inputClass} min-h-11 flex-1`}
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("createSkill.messagePlaceholder")}
              />
              <ActionButton type="submit" className={secondary} disabled={!text.trim()} busy={send.pending}>
                {t("createSkill.send")}
              </ActionButton>
            </form>
          </>
        ) : null}

        {chat.sendError ? <InlineAlert tone="danger">{chat.sendError.message}</InlineAlert> : null}
        {chat.notice ? <InlineAlert tone="danger">{chat.notice}</InlineAlert> : null}
      </div>
    </Sheet>
  );
}
