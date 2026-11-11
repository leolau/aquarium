"use client";

import { useCallback, useRef, useState } from "react";

import { errorText, getJson, sendJson } from "@/lib/admin-fetch";
import { extractDraft as extractSkillDraft, type ImproveReply } from "@/lib/skills/improve";
import { useAction } from "@/lib/use-action";
import type { ChatMessage, ChatMessagesResponse } from "@/types";

const SEED_MESSAGE_MARK = "\n\n## My message\n";

/** The first user turn carries the hidden seed; show only what the user typed. */
export function withoutSeed(content: string, seedStart: string): string {
  if (!content.startsWith(seedStart)) return content;
  const at = content.lastIndexOf(SEED_MESSAGE_MARK);
  return at === -1 ? content : content.slice(at + SEED_MESSAGE_MARK.length);
}

/** User and assistant text turns; tool-call-only assistant rows have no text and are skipped. */
export function visibleTurns(messages: ChatMessage[], seedStart: string): ChatMessage[] {
  return messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && (m.content ?? "").trim() !== ""))
    .map((m, i) => (i === 0 && m.role === "user" ? { ...m, content: withoutSeed(m.content ?? "", seedStart) } : m));
}

export interface LabChatOptions<S> {
  /** POST endpoint that opens a chat and answers `{session_id}`. */
  startUrl: string;
  /** Body for `startUrl`; `goal` is "" when the chat starts from the first message. */
  startBody: (goal: string) => Record<string, unknown>;
  /** POST endpoint taking `{session_id, text, ...messageBody}` and answering `{reply, draft?}`. */
  messageUrl: string;
  messageBody?: Record<string, unknown>;
  /** Query string (no `?`) appended to the transcript read, e.g. `profile=x`. */
  transcriptQuery?: string;
  /** Start of the hidden first-turn seed, stripped from reopened transcripts. */
  seedStart: string;
  extractDraft?: (text: string) => string | null;
  /** Persist a draft; whatever it returns is exposed as `saved`. */
  save: (draft: string, sessionId: string | null) => Promise<S>;
  /** The server-side list of chats or drafts may have changed. */
  onChanged?: () => void;
}

/**
 * Chat-and-draft state shared by the Skills Lab chats (improve a skill, create
 * one): one server-side session, its visible turns, the latest proposed draft
 * and saving it. The seed travels only in the first user turn (cache-safe).
 */
export function useLabChat<S>(opts: LabChatOptions<S>) {
  const extract = opts.extractDraft ?? extractSkillDraft;
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Read by send() so a retry right after the first turn reuses the session it started.
  const sessionRef = useRef<string | null>(null);
  const [turns, setTurns] = useState<ChatMessage[]>([]);
  const [transcript, setTranscript] = useState<"idle" | "loading" | string>("idle");
  const [draft, setDraftState] = useState<string | null>(null);
  /** Bumps on every new draft, so views can reset per-draft UI without effects. */
  const [draftRev, setDraftRev] = useState(0);
  const [saved, setSaved] = useState<S | null>(null);
  const [sendError, setSendError] = useState<{ text: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const keySeq = useRef(0);

  const setDraft = useCallback((next: string | null) => {
    setDraftState(next);
    setDraftRev((r) => r + 1);
    setSaved(null);
  }, []);

  const focusComposer = useCallback(() => composerRef.current?.focus(), []);

  async function openTranscript(id: string) {
    sessionRef.current = id;
    setSessionId(id);
    setTurns([]);
    setDraft(null);
    setSendError(null);
    setNotice(null);
    setTranscript("loading");
    try {
      const q = opts.transcriptQuery ? `&${opts.transcriptQuery}` : "";
      const res = await getJson<ChatMessagesResponse>(`/api/chat/messages?sessionId=${encodeURIComponent(id)}&visible=1${q}`);
      const rows = visibleTurns(res.messages ?? [], opts.seedStart);
      const last = [...rows].reverse().find((m) => m.role === "assistant" && extract(m.content ?? "") !== null);
      setTurns(rows);
      setDraft(last ? extract(last.content ?? "") : null);
      setTranscript("idle");
    } catch (err) {
      setTranscript(errorText(err));
    }
  }

  async function startSession(goal: string): Promise<string> {
    const res = await sendJson<{ session_id: string }>(opts.startUrl, "POST", opts.startBody(goal));
    opts.onChanged?.();
    return res.session_id;
  }

  /** Open a fresh chat (optionally with a goal); resolves true once it is shown. */
  const start = useAction(async (goal: string): Promise<boolean> => {
    setNotice(null);
    try {
      const id = await startSession(goal.trim());
      await openTranscript(id);
      focusComposer();
      return true;
    } catch (err) {
      setNotice(errorText(err));
      return false;
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
      const res = await sendJson<ImproveReply>(opts.messageUrl, "POST", { session_id: id, text: message, ...opts.messageBody });
      const proposal = res.draft ?? extract(res.reply ?? "");
      setTurns((t) => [...t, { role: "assistant", content: res.reply ?? "", clientKey: `${key}-reply` }]);
      if (proposal) {
        setDraft(proposal);
        opts.onChanged?.();
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
      setSaved(await opts.save(draft, sessionRef.current));
      opts.onChanged?.();
    } catch (err) {
      setNotice(errorText(err));
    }
  });

  /** Append text to the composer (e.g. a run reference) and focus it. */
  function insert(snippet: string) {
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n${snippet} ` : `${snippet} `));
    focusComposer();
  }

  return {
    sessionId,
    turns,
    transcript,
    draft,
    draftRev,
    saved,
    sendError,
    notice,
    setNotice,
    text,
    setText,
    composerRef,
    focusComposer,
    openTranscript,
    insert,
    start,
    send,
    save,
  };
}

export type LabChat<S> = ReturnType<typeof useLabChat<S>>;
