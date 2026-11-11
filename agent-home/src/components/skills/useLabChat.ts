"use client";

/**
 * A Skills Lab chat: start a session, send turns, keep the latest SKILL.md
 * draft the agent proposed. Generic over the routes so Improve (B3) and
 * "New skill with AI" (B4) can share it.
 */
import { useCallback, useRef, useState } from "react";

import { errorText, sendJson } from "@/lib/admin-fetch";
import { extractDraft, type ImproveReply } from "@/lib/skills/improve";

/** The reply without its skill-draft blocks (fences of 3+ backticks); the draft renders as its own card. */
export function stripLabDraft(text: string): string {
  return text
    .replace(/(`{3,})skill-draft[^\n]*\n[\s\S]*?\n?\1(?!`)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface LabTurn {
  role: "user" | "assistant";
  content: string;
  key: string;
}

export interface LabChatOptions {
  /** e.g. `/api/skills/create/start`; must answer `{session_id}`. */
  startUrl: string;
  /** e.g. `/api/skills/create/message`; answers {@link ImproveReply}. */
  messageUrl: string;
  /** Merged into every message body (e.g. `{profile}`). */
  scope?: Record<string, unknown>;
}

export function useLabChat({ startUrl, messageUrl, scope }: LabChatOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<LabTurn[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const sessionRef = useRef<string | null>(null);

  const start = useCallback(
    async (body: Record<string, unknown>): Promise<string | null> => {
      setError(null);
      try {
        const res = await sendJson<{ session_id: string }>(startUrl, "POST", body);
        sessionRef.current = res.session_id;
        setSessionId(res.session_id);
        return res.session_id;
      } catch (err) {
        setError(errorText(err));
        return null;
      }
    },
    [startUrl],
  );

  const send = useCallback(
    async (raw: string): Promise<boolean> => {
      const text = raw.trim();
      const id = sessionRef.current;
      if (!text || !id) return false;
      const key = `t${++seq.current}`;
      setError(null);
      setSending(true);
      setTurns((t) => [...t, { role: "user", content: text, key }]);
      try {
        const res = await sendJson<ImproveReply>(messageUrl, "POST", { session_id: id, text, ...scope });
        const proposal = res.draft ?? extractDraft(res.reply ?? "");
        setTurns((t) => [...t, { role: "assistant", content: stripLabDraft(res.reply ?? ""), key: `${key}r` }]);
        if (proposal) setDraft(proposal);
        return true;
      } catch (err) {
        setTurns((t) => t.filter((m) => m.key !== key));
        setError(errorText(err));
        return false;
      } finally {
        setSending(false);
      }
    },
    [messageUrl, scope],
  );

  return { sessionId, turns, draft, setDraft, sending, error, setError, start, send };
}
