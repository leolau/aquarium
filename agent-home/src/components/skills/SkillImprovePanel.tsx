"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import { accentChipClass, chipClass, toolButtonClass } from "@/components/skills/SkillPage";
import { ActionButton } from "@/components/ui/ActionButton";
import { FolderIcon, PlusIcon, SparklesIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Spinner } from "@/components/ui/Spinner";
import { errorText, getJson, profileQuery, sendJson } from "@/lib/admin-fetch";
import { diffLines, hunks } from "@/lib/skills/diff";
import {
  evidenceReference,
  evidenceStatus,
  evidenceTitle,
  extractDraft,
  matchesEvidence,
  nextVersionNumber,
  shortDate,
  stripDraft,
  versionLabel,
  type EvidenceFilter,
  type ImproveReply,
  type ImproveSession,
  type SkillUsageDetail,
  type SkillUsageEvent,
  type SkillVersionList,
  type SkillVersionMeta,
} from "@/lib/skills/improve";
import { useAction } from "@/lib/use-action";
import type { ChatMessage, ChatMessagesResponse } from "@/types";

type Loaded<T> = { data: T; error: null } | { data: null; error: string } | null;

const PREVIEW_LINES = 12;
const STATUS_TONE: Record<ReturnType<typeof evidenceStatus>["tone"], string> = {
  danger: "border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-[var(--color-danger)]",
  warn: "border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] text-[var(--color-warn-text)]",
  success: "border-[color-mix(in_srgb,var(--color-success)_40%,transparent)] text-[var(--color-success)]",
  muted: "border-[var(--color-border)] text-[var(--color-muted)]",
};
const cardClass = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5";
const sectionLabel = "mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]";

async function load<T>(url: string): Promise<Loaded<T>> {
  try {
    return { data: await getJson<T>(url), error: null };
  } catch (err) {
    return { data: null, error: errorText(err) };
  }
}

const SEED_START = "You are helping me improve the skill ";
const SEED_MESSAGE_MARK = "\n\n## My message\n";

/** The first user turn carries the hidden skill context; show only what the user typed. */
function withoutSeed(content: string): string {
  if (!content.startsWith(SEED_START)) return content;
  const at = content.lastIndexOf(SEED_MESSAGE_MARK);
  return at === -1 ? content : content.slice(at + SEED_MESSAGE_MARK.length);
}

/** User and assistant text turns; tool-call-only assistant rows have no text and are skipped. */
function visibleTurns(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && (m.content ?? "").trim() !== ""))
    .map((m, i) => (i === 0 && m.role === "user" ? { ...m, content: withoutSeed(m.content ?? "") } : m));
}

/**
 * Improve tab of /skills/[name] (Figma 39:3814): a chat with the agent about
 * this skill. Proposals come back as a SKILL.md draft that is saved as a new
 * version; the live skill only changes when someone tries that version.
 */
export function SkillImprovePanel({
  name,
  profile,
  content,
  onOpenTab,
}: {
  name: string;
  profile: string;
  /** The live (active) SKILL.md, the baseline a proposal is compared with. */
  content: string;
  onOpenTab: (tab: string) => void;
}) {
  const q = profileQuery(profile);
  const scoped = useMemo(() => (q ? { profile } : {}), [q, profile]);
  const withQ = useCallback((path: string) => (q ? `${path}&${q}` : path), [q]);
  const enc = encodeURIComponent(name);

  const [versions, setVersions] = useState<Loaded<SkillVersionList>>(null);
  const [evidence, setEvidence] = useState<Loaded<SkillUsageDetail>>(null);
  const [sessions, setSessions] = useState<Loaded<ImproveSession[]>>(null);
  const [filter, setFilter] = useState<EvidenceFilter>("failed");

  const [sessionId, setSessionId] = useState<string | null>(null);
  // Read by send() so a retry right after the first turn reuses the session it started.
  const sessionRef = useRef<string | null>(null);
  const [turns, setTurns] = useState<ChatMessage[]>([]);
  const [transcript, setTranscript] = useState<"idle" | "loading" | string>("idle");
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<SkillVersionMeta | null>(null);
  const [fullDiff, setFullDiff] = useState(false);
  const [sendError, setSendError] = useState<{ text: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const keySeq = useRef(0);

  const versionsUrl = withQ(`/api/skills/versions?name=${enc}`);
  const evidenceUrl = withQ(`/api/skills/usage/detail?name=${enc}&days=90&limit=50`);
  const sessionsUrl = withQ(`/api/skills/improve/sessions?name=${enc}`);
  const loadVersions = () => load<SkillVersionList>(versionsUrl).then(setVersions);
  const loadEvidence = () => load<SkillUsageDetail>(evidenceUrl).then(setEvidence);
  const loadSessions = () => load<ImproveSession[]>(sessionsUrl).then(setSessions);

  useEffect(() => {
    let live = true;
    void load<SkillVersionList>(versionsUrl).then((r) => live && setVersions(r));
    void load<SkillUsageDetail>(evidenceUrl).then((r) => live && setEvidence(r));
    void load<ImproveSession[]>(sessionsUrl).then((r) => live && setSessions(r));
    return () => {
      live = false;
    };
  }, [versionsUrl, evidenceUrl, sessionsUrl]);

  const versionList = versions?.data ?? null;
  const activeLabel = versionLabel(versionList, versionList?.active ?? null);
  const nextN = versionList ? nextVersionNumber(versionList.versions) : null;
  const events = useMemo(() => evidence?.data?.events ?? [], [evidence]);
  const counts = useMemo(
    () => ({
      failed: events.filter((e) => matchesEvidence(e, "failed")).length,
      unhelpful: events.filter((e) => matchesEvidence(e, "unhelpful")).length,
      all: events.length,
    }),
    [events],
  );
  const shown = events.filter((e) => matchesEvidence(e, filter));
  const current = sessions?.data?.find((s) => s.session_id === sessionId) ?? null;

  const ops = useMemo(() => (draft === null ? [] : diffLines(content.replace(/\s+$/, ""), draft.replace(/\s+$/, ""))), [content, draft]);
  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;
  const changed = ops.filter((o) => o.type !== "same");

  function focusComposer() {
    composerRef.current?.focus();
  }

  async function openTranscript(id: string) {
    sessionRef.current = id;
    setSessionId(id);
    setTurns([]);
    setDraft(null);
    setSaved(null);
    setFullDiff(false);
    setSendError(null);
    setNotice(null);
    setTranscript("loading");
    try {
      const res = await getJson<ChatMessagesResponse>(
        `/api/chat/messages?sessionId=${encodeURIComponent(id)}&visible=1${q ? `&${q}` : ""}`,
      );
      const rows = visibleTurns(res.messages ?? []);
      const lastDraft = [...rows].reverse().find((m) => m.role === "assistant" && extractDraft(m.content ?? "") !== null);
      setTurns(rows);
      setDraft(lastDraft ? extractDraft(lastDraft.content) : null);
      setTranscript("idle");
    } catch (err) {
      setTranscript(errorText(err));
    }
  }

  async function startSession(goalText: string): Promise<string> {
    const res = await sendJson<{ session_id: string }>("/api/skills/improve/start", "POST", {
      name,
      ...(goalText ? { goal: goalText } : {}),
      ...scoped,
    });
    void loadSessions();
    return res.session_id;
  }

  const start = useAction(async () => {
    setNotice(null);
    try {
      const id = await startSession(goal.trim());
      setGoal("");
      setGoalOpen(false);
      await openTranscript(id);
      focusComposer();
    } catch (err) {
      setNotice(errorText(err));
    }
  });

  const send = useAction(async (raw: string) => {
    const message = raw.trim();
    if (!message) return;
    setSendError(null);
    setNotice(null);
    const key = `local-${++keySeq.current}`;
    setTurns((t) => [...t, { role: "user", content: message, clientKey: key }]);
    setText("");
    try {
      let id = sessionRef.current;
      if (!id) {
        id = await startSession("");
        sessionRef.current = id;
        setSessionId(id);
      }
      const res = await sendJson<ImproveReply>("/api/skills/improve/message", "POST", { session_id: id, text: message, ...scoped });
      const proposal = res.draft ?? extractDraft(res.reply ?? "");
      setTurns((t) => [...t, { role: "assistant", content: res.reply ?? "", clientKey: `${key}-reply` }]);
      if (proposal) {
        setDraft(proposal);
        setSaved(null);
        setFullDiff(false);
        void loadSessions();
      }
    } catch (err) {
      setTurns((t) => t.filter((m) => m.clientKey !== key));
      setSendError({ text: message, message: errorText(err) });
    }
  });

  const save = useAction(async () => {
    if (draft === null) return;
    setNotice(null);
    try {
      const meta = await sendJson<SkillVersionMeta>("/api/skills/versions/draft", "POST", {
        name,
        content: draft,
        message: current?.title || "Improve chat proposal",
        ...(sessionId ? { session_id: sessionId } : {}),
        ...scoped,
      });
      setSaved(meta);
      void loadVersions();
      void loadSessions();
    } catch (err) {
      setNotice(errorText(err));
    }
  });

  function insertEvidence(event: SkillUsageEvent) {
    const ref = evidenceReference(event, versionList);
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n${ref} ` : `${ref} `));
    focusComposer();
  }

  function submitGoal(e: FormEvent) {
    e.preventDefault();
    void start.run();
  }

  const filterChip = (id: EvidenceFilter, label: string, count: number | null) => (
    <button
      key={id}
      type="button"
      aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      className={`${filter === id ? accentChipClass : chipClass} !min-h-7 cursor-pointer`}
    >
      {count === null ? label : `${label} ${count}`}
    </button>
  );

  return (
    <div data-component="SkillImprovePanel" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-3">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <h2 className="break-all text-base font-semibold">Improve {name} with the agent</h2>
            <p className="text-xs text-[var(--color-muted)]">
              {activeLabel ? `Based on ${activeLabel} (active) · ` : ""}
              the agent can read the evidence {""}
              <span className="lg:hidden">below</span>
              <span className="hidden lg:inline">on the right</span> but cannot change the live skill
            </p>
          </div>
          <button type="button" className={`${toolButtonClass} inline-flex items-center gap-1.5 self-start`} onClick={() => setGoalOpen((o) => !o)} aria-expanded={goalOpen}>
            <PlusIcon size={14} /> New improve chat
          </button>
        </header>

        {goalOpen ? (
          <form onSubmit={submitGoal} className={`${cardClass} flex flex-col gap-2 sm:flex-row sm:items-center`}>
            <label className="sr-only" htmlFor="improve-goal">
              Goal (optional)
            </label>
            <input
              id="improve-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Goal (optional), e.g. fix the currency failures"
              className="min-h-10 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            />
            <div className="flex gap-2">
              <ActionButton type="submit" busy={start.pending} busyLabel="Starting…" className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60">
                Start chat
              </ActionButton>
              <button type="button" className={toolButtonClass} onClick={() => setGoalOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {notice ? <InlineAlert tone="danger">{notice}</InlineAlert> : null}

        <div aria-live="polite" className="flex flex-col gap-2.5">
          {transcript === "loading" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Spinner /> Loading the chat…
            </p>
          ) : transcript !== "idle" ? (
            <InlineAlert
              tone="danger"
              title="This chat couldn't be loaded."
              action={
                sessionId ? (
                  <button type="button" className={toolButtonClass} onClick={() => void openTranscript(sessionId)}>
                    Retry
                  </button>
                ) : null
              }
            >
              {transcript}
            </InlineAlert>
          ) : turns.length === 0 && !send.pending ? (
            <div className={`${cardClass} text-sm text-[var(--color-muted)]`}>
              {sessionId
                ? "Tell the agent what to change, or pick runs to discuss."
                : "Start an improve chat to work on this skill with the agent. It sees the active SKILL.md, its versions and the runs that used it, and proposes a new version you can save as a draft."}
            </div>
          ) : null}

          {turns.map((m, i) => {
            const shownText = m.role === "assistant" ? stripDraft(m.content ?? "") || "Here is a proposed SKILL.md." : m.content;
            return <MessageBubble key={m.clientKey ?? m.id ?? i} message={{ ...m, content: shownText }} msgIndex={i} />;
          })}

          {send.pending ? (
            <p role="status" className="flex items-center gap-2 self-start rounded-2xl bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]">
              <Spinner /> The agent is thinking…
            </p>
          ) : null}

          {sendError ? (
            <InlineAlert
              tone="danger"
              title="The message didn't go through."
              action={
                <button type="button" className={toolButtonClass} disabled={send.pending} onClick={() => void send.run(sendError.text)}>
                  Retry
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
            aria-label="Proposed SKILL.md"
            className="rounded-2xl border border-[var(--color-accent)] bg-[var(--color-surface)] p-3.5"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <SparklesIcon size={16} className="text-[var(--color-accent)]" />
              <h3 className="text-sm font-semibold">Proposed SKILL.md</h3>
              <span className={accentChipClass}>{added || removed ? `+${added} −${removed} lines` : "no changes"}</span>
            </div>
            <DiffPreview ops={ops} changed={changed} full={fullDiff} />
            {saved ? (
              <InlineAlert
                tone="success"
                className="mt-2.5"
                action={
                  <button type="button" className={toolButtonClass} onClick={() => onOpenTab("versions")}>
                    Open in Versions
                  </button>
                }
              >
                Saved as draft v{saved.n}. Nothing changes for other chats until you choose Try.
              </InlineAlert>
            ) : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {!saved ? (
                <ActionButton
                  onAction={() => save.run()}
                  busy={save.pending}
                  busyLabel="Saving…"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-3.5 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
                >
                  <PlusIcon size={14} /> {nextN ? `Save as draft v${nextN}` : "Save as draft"}
                </ActionButton>
              ) : null}
              <button
                type="button"
                className={toolButtonClass}
                aria-expanded={saved ? undefined : fullDiff}
                onClick={() => (saved ? onOpenTab("versions") : setFullDiff((f) => !f))}
              >
                {!saved && fullDiff ? "Show changes only" : "View full diff"}
              </button>
              <button type="button" className="min-h-9 px-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]" onClick={focusComposer}>
                Ask for changes
              </button>
            </div>
          </section>
        ) : null}

        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
          <label htmlFor="improve-composer" className="sr-only">
            Message the agent
          </label>
          <textarea
            id="improve-composer"
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
            placeholder="Tell the agent what to change, or pick runs to discuss…"
            className="max-h-48 min-h-[46px] w-full resize-y rounded-xl bg-transparent px-1.5 py-1.5 text-sm outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="hidden text-xs text-[var(--color-muted)] sm:inline">Enter to send · Shift+Enter for a new line</span>
            <button
              type="button"
              disabled={send.pending || !text.trim()}
              onClick={() => void send.run(text)}
              className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
            >
              {send.pending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      <aside className="flex flex-col gap-3" aria-label="Improve context">
        <section className={cardClass} aria-label="Evidence shared with the agent">
          <h3 className={sectionLabel}>Evidence shared with the agent</h3>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {filterChip("failed", "Failed", evidence?.data ? counts.failed : null)}
            {filterChip("unhelpful", "Not helpful", evidence?.data ? counts.unhelpful : null)}
            {filterChip("all", "All runs", null)}
          </div>
          {evidence === null ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Spinner /> Loading runs…
            </p>
          ) : evidence.error !== null ? (
            <InlineAlert
              tone="danger"
              action={
                <button type="button" className={toolButtonClass} onClick={() => void loadEvidence()}>
                  Retry
                </button>
              }
            >
              Runs couldn&apos;t be loaded. {evidence.error}
            </InlineAlert>
          ) : shown.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              {events.length === 0 ? "No recorded runs in the last 90 days." : "No runs match this filter."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((e) => {
                const { kind, title } = evidenceTitle(e);
                const status = evidenceStatus(e);
                const meta = [versionLabel(versionList, e.version_id), e.trigger, shortDate(e.ts), e.note ? `“${e.note}”` : ""].filter(Boolean).join(" · ");
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => insertEvidence(e)}
                      title="Add this run to your message"
                      className="flex w-full flex-wrap items-start gap-2 rounded-xl border border-[var(--color-border)] p-2.5 text-left hover:border-[var(--color-accent)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-[13px] font-medium">
                          {kind} · {title}
                        </span>
                        {meta ? <span className="block break-words text-xs text-[var(--color-muted)]">{meta}</span> : null}
                      </span>
                      <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-px text-[11px] ${STATUS_TONE[status.tone]}`}>{status.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={cardClass} aria-label="Past improve chats">
          <h3 className={sectionLabel}>Past improve chats</h3>
          {sessions === null ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <Spinner /> Loading chats…
            </p>
          ) : sessions.error !== null ? (
            <InlineAlert
              tone="danger"
              action={
                <button type="button" className={toolButtonClass} onClick={() => void loadSessions()}>
                  Retry
                </button>
              }
            >
              Past chats couldn&apos;t be loaded. {sessions.error}
            </InlineAlert>
          ) : sessions.data.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">No improve chats yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.data.map((s) => (
                <li key={s.session_id}>
                  <button
                    type="button"
                    aria-current={s.session_id === sessionId ? "true" : undefined}
                    onClick={() => void openTranscript(s.session_id)}
                    className={`flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left ${
                      s.session_id === sessionId ? "border-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    <FolderIcon size={16} className="shrink-0 text-[var(--color-muted)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{s.title || "Untitled improve chat"}</span>
                      <span className="block text-xs text-[var(--color-muted)]">
                        {[shortDate(s.started_at), `${s.drafts} ${s.drafts === 1 ? "draft" : "drafts"}`].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span aria-hidden className="text-[var(--color-muted)]">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <InlineAlert tone="info">
          Improve chats run as you, with your permissions. Drafts are saved as new versions; nothing changes for other chats until you choose Try.
        </InlineAlert>
      </aside>
    </div>
  );
}

function DiffPreview({ ops, changed, full }: { ops: ReturnType<typeof diffLines>; changed: ReturnType<typeof diffLines>; full: boolean }) {
  const line = (op: ReturnType<typeof diffLines>[number], key: string | number) => (
    <div
      key={key}
      data-diff={op.type}
      className={`whitespace-pre-wrap break-words px-2 ${
        op.type === "add" ? "text-[var(--color-success)]" : op.type === "del" ? "text-[var(--color-danger)] line-through" : "text-[var(--color-muted)]"
      }`}
    >
      <span aria-hidden className="mr-2 select-none">
        {op.type === "add" ? "+" : op.type === "del" ? "−" : " "}
      </span>
      {op.text || " "}
    </div>
  );
  if (changed.length === 0) {
    return <p className="rounded-xl bg-[var(--color-surface-2)] p-2.5 text-xs text-[var(--color-muted)]">Same as the active version.</p>;
  }
  return (
    <div className="max-h-96 overflow-auto rounded-xl bg-[var(--color-surface-2)] py-2 font-mono text-[12px] leading-5">
      {full
        ? hunks(ops, 3).map((h, i) =>
            "skipped" in h ? (
              <div key={`s${i}`} className="px-2 text-[var(--color-muted)]">
                ⋯ {h.skipped} unchanged {h.skipped === 1 ? "line" : "lines"}
              </div>
            ) : (
              h.ops.map((op, j) => line(op, `${i}-${j}`))
            ),
          )
        : changed.slice(0, PREVIEW_LINES).map((op, i) => line(op, i))}
      {!full && changed.length > PREVIEW_LINES ? (
        <div className="px-2 text-[var(--color-muted)]">… {changed.length - PREVIEW_LINES} more changed lines</div>
      ) : null}
    </div>
  );
}
