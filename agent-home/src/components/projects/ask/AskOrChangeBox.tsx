"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import {
  ASK_SUGGESTIONS,
  CHANGE_KINDS,
  QUESTION_MAX,
  capTurns,
  historyFor,
  isSendKey,
  newTurnId,
  parseThread,
  readThreadRaw,
  saveThread,
  sourceHref,
  sourceTab,
  suggestedRequirement,
  updateTurn,
  withKindPrefix,
  type AskTurn,
  type ChangeKind,
} from "@/components/projects/ask/askThread";
import type { ProjectTab } from "@/components/projects/tabs/types";
import {
  useProjectAction,
  type ActionResult,
} from "@/components/projects/useProjectAction";
import type { AskProjectResponse, AskProjectSource, ProjectDetail } from "@/types";

type Mode = "ask" | "change";

const HINT: Record<Mode, string> = {
  ask: "Answers come from the project's live state: cards, runs, outputs and requirements. It only reads, and won't interrupt running tasks.",
  change:
    "Say what should change. You'll check it before it's saved; changes apply from the next run.",
};

const PLACEHOLDER: Record<Mode, string> = {
  ask: "Ask anything, e.g. What's left before I can sign? Why is step 4 slow?",
  change: "e.g. Add a 3-year term and Hong Kong governing law to all four MOUs…",
};

function sessionStore(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

const noSubscribe = () => () => {};

const chipClass = (on: boolean) =>
  `inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${
    on
      ? "border-[var(--color-accent)] text-[var(--color-accent)]"
      : "border-[var(--color-border)] text-[var(--color-muted)]"
  } disabled:opacity-50`;

/**
 * One box under the live bar: "Ask about this project" (read-only Q&A) or
 * "Add requirement / change" (hands the text to `onChangeRequest`).
 */
export function AskOrChangeBox({
  project,
  onChangeRequest,
  onNavigate,
}: {
  project: ProjectDetail;
  onChangeRequest: (initialText?: string) => void;
  /** Switch tab in place for sources that live on a tab; without it they link to `?tab=`. */
  onNavigate?: (tab: ProjectTab) => void;
}) {
  const slug = project.slug;
  const [mode, setMode] = useState<Mode>("ask");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ChangeKind | null>(null);
  // The thread restored from sessionStorage on the client ([] on the
  // server), until this page changes it; from then on local state rules.
  const storedRaw = useSyncExternalStore(
    noSubscribe,
    () => readThreadRaw(sessionStore(), slug),
    () => null,
  );
  const restored = useMemo(() => parseThread(storedRaw), [storedRaw]);
  const [local, setLocal] = useState<{ slug: string; turns: AskTurn[] } | null>(null);
  const turns = local && local.slug === slug ? local.turns : restored;
  const setTurns = useCallback(
    (next: (prev: AskTurn[]) => AskTurn[]) =>
      setLocal((cur) => ({
        slug,
        turns: next(cur && cur.slug === slug ? cur.turns : restored),
      })),
    [restored, slug],
  );
  const action = useProjectAction<AskProjectResponse>();
  const sending = useRef(false);
  const activeTurn = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (local) saveThread(sessionStore(), local.slug, local.turns);
  }, [local]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const settle = useCallback(
    (id: string, result: ActionResult<AskProjectResponse> | null) => {
      if (!result) return;
      if (result.ok && result.data) {
        const data = result.data;
        setTurns((prev) =>
          updateTurn(prev, id, {
            status: "done",
            a: data.answer,
            sources: data.sources ?? [],
            suggestion: data.suggested_requirement,
            error: undefined,
          }),
        );
      } else {
        setTurns((prev) =>
          updateTurn(prev, id, {
            status: "error",
            error: result.error ?? "That did not go through.",
          }),
        );
      }
    },
    [setTurns],
  );

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || question.length > QUESTION_MAX) return;
      if (sending.current || action.busy) return;
      sending.current = true;
      const id = newTurnId();
      activeTurn.current = id;
      setActiveId(id);
      const history = historyFor(turns);
      setTurns((prev) => capTurns([...prev, { id, q: question, status: "pending" }]));
      setText("");
      try {
        const result = await action.run(`/api/projects/${encodeURIComponent(slug)}/ask`, {
          body: { question, history },
          skipRefresh: true,
        });
        settle(id, result);
      } finally {
        sending.current = false;
      }
    },
    [action, setTurns, settle, slug, turns],
  );

  const retry = useCallback(async () => {
    const id = activeTurn.current;
    if (!id || sending.current) return;
    sending.current = true;
    setTurns((prev) => updateTurn(prev, id, { status: "pending", error: undefined }));
    try {
      settle(id, await action.retry());
    } finally {
      sending.current = false;
    }
  }, [action, setTurns, settle]);

  const handOver = useCallback(() => {
    const out = withKindPrefix(kind, text);
    if (!text.trim() && !kind) return;
    onChangeRequest(out);
    setText("");
    setKind(null);
  }, [kind, onChangeRequest, text]);

  const submit = useCallback(() => {
    if (mode === "ask") void ask(text);
    else handOver();
  }, [ask, handOver, mode, text]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      isSendKey({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode,
      })
    ) {
      e.preventDefault();
      submit();
    }
  };

  const tooLong = text.trim().length > QUESTION_MAX;
  const lastErrorId = [...turns].reverse().find((t) => t.status === "error")?.id;

  return (
    <section
      data-component="AskOrChangeBox"
      aria-label="Ask or change"
      className="flex flex-col gap-2 rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-surface)] p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Mode"
          className="inline-flex rounded-xl bg-[var(--color-surface-2)] p-0.5"
        >
          {(
            [
              ["ask", "💬 Ask about this project"],
              ["change", "＋ Add requirement / change"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-mode={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-2.5 py-1.5 text-xs sm:text-sm ${
                mode === m
                  ? "bg-[var(--color-surface)] font-semibold shadow-sm"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p data-hint className="text-xs text-[var(--color-muted)]">
          {HINT[mode]}
        </p>
      </div>

      {mode === "ask" && turns.length > 0 ? (
        <div
          ref={threadRef}
          data-thread
          aria-live="polite"
          className="flex max-h-72 flex-col gap-2 overflow-y-auto"
        >
          {turns.map((turn) => (
            <AskTurnView
              key={turn.id}
              turn={turn}
              slug={slug}
              onNavigate={onNavigate}
              onTurnInto={() => onChangeRequest(suggestedRequirement(turn))}
              retry={
                turn.id === lastErrorId && turn.id === activeId
                  ? { busy: action.busy, run: () => void retry() }
                  : null
              }
            />
          ))}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={action.busy}
              onClick={() => setTurns(() => [])}
              className="text-xs text-[var(--color-muted)] underline disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <textarea
        aria-label={mode === "ask" ? "Your question" : "What should change"}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={PLACEHOLDER[mode]}
        className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      {tooLong ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          Keep it under {QUESTION_MAX} characters.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {mode === "ask" ? (
          <>
            <span className="text-xs text-[var(--color-muted)]">Try:</span>
            {ASK_SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                data-suggestion
                disabled={action.busy}
                onClick={() => void ask(s.question)}
                className={chipClass(false)}
              >
                {s.label}
              </button>
            ))}
          </>
        ) : (
          CHANGE_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              data-kind={k.id}
              aria-pressed={kind === k.id}
              onClick={() => setKind((cur) => (cur === k.id ? null : k.id))}
              className={chipClass(kind === k.id)}
            >
              <span aria-hidden>{k.icon}</span>
              {k.label}
            </button>
          ))
        )}
        <span className="flex-1" />
        {mode === "ask" ? (
          <ActionButton
            busy={action.busy}
            pendingLabel="Asking…"
            disabled={!text.trim() || tooLong}
            onClick={() => void ask(text)}
            className="rounded-xl bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Ask
          </ActionButton>
        ) : (
          <button
            type="button"
            disabled={!text.trim() && !kind}
            onClick={handOver}
            className="rounded-xl bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Continue ›
          </button>
        )}
      </div>
    </section>
  );
}

function AskTurnView({
  turn,
  slug,
  onNavigate,
  onTurnInto,
  retry,
}: {
  turn: AskTurn;
  slug: string;
  onNavigate?: (tab: ProjectTab) => void;
  onTurnInto: () => void;
  retry: { busy: boolean; run: () => void } | null;
}) {
  return (
    <div data-turn={turn.status} className="flex flex-col gap-1.5 text-sm">
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-[var(--color-surface-2)] px-3 py-1.5">
          {turn.q}
        </p>
      </div>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        {turn.status === "pending" ? (
          <p className="inline-flex items-center gap-1.5 text-xs italic text-[var(--color-muted)]">
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
            reading cards, runs and outputs…
          </p>
        ) : turn.status === "error" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {turn.error}
            </p>
            {retry ? (
              <ActionButton busy={retry.busy} pendingLabel="Asking…" onClick={retry.run}>
                Try again
              </ActionButton>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="whitespace-pre-wrap break-words">{turn.a}</p>
            {turn.sources && turn.sources.length > 0 ? (
              <p data-sources className="text-xs text-[var(--color-muted)]">
                Sources:{" "}
                {turn.sources.map((source, i) => (
                  <span key={`${source.kind}:${source.id}`}>
                    {i > 0 ? " · " : null}
                    <SourceLink slug={slug} source={source} onNavigate={onNavigate} />
                  </span>
                ))}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                data-turn-into
                onClick={onTurnInto}
                className={chipClass(false)}
              >
                Turn into a requirement…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceLink({
  slug,
  source,
  onNavigate,
}: {
  slug: string;
  source: AskProjectSource;
  onNavigate?: (tab: ProjectTab) => void;
}) {
  const href = sourceHref(slug, source);
  const tab = sourceTab(source);
  const cls = "text-[var(--color-accent)] underline";
  if (tab === null) {
    return (
      <Link href={href} className={cls} data-source={source.kind}>
        {source.label}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={cls}
      data-source={source.kind}
      onClick={(e) => {
        if (!onNavigate) return;
        e.preventDefault();
        onNavigate(tab);
      }}
    >
      {source.label}
    </a>
  );
}
