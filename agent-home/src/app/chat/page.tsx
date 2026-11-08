import { ChatHeaderActions } from "@/components/chat/ChatHeaderActions";
import { ChatPane } from "@/components/chat/ChatPane";
import { SwitchOnArrival } from "@/components/SwitchOnArrival";
import { MobileShell } from "@/components/MobileShell";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { storageConfigured } from "@/lib/env";
import type { ChatMessage, SessionSummary } from "@/types";

// Reads the live principal (cookie) + the C2-scoped conversation list per
// request — never at build time.
export const dynamic = "force-dynamic";

/**
 * FG-20 Wave C1 — the one-brain chat tab. BFF: the server resolves the
 * principal and loads the principal's conversations (every source,
 * including cron — see `categorizeSession`/`SessionTabs`, which groups
 * them inline instead of hiding them, and the most recent one's
 * transcript) from the Python API, then hands them to the interactive
 * {@link ChatPane}. Sending routes back through `/api/chat/*` to the
 * principal-scoped `POST /api/sessions/{id}/chat` endpoint.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    session?: string;
    profile?: string;
    draft?: string;
    new?: string;
    autosend?: string;
  }>;
}) {
  await requirePrincipal();
  // `?session=<id>` is where a memory's citation link lands. The chat
  // addresses the session's profile (FG-28) — a whole HERMES_HOME, so it is
  // the brain that answers *and* the conversations shown. A `?profile=<name>`
  // link (an old bookmark, a shared URL) switches the session first, so the
  // header, the chat and every later page agree on one profile.
  // `?draft=<text>` pre-fills the composer (a project's "ask the agent to
  // draft a plan" door) — nothing is sent until the user presses send.
  const {
    session: requested,
    profile: requestedProfile,
    draft,
    new: startNew,
    autosend,
  } = await searchParams;
  // `?new=1` opens a fresh conversation (the landing composer's hand-off);
  // `&autosend=1` sends `draft` as its first turn.
  const freshChat = startNew === "1";
  const profile = (await readSession())?.profile ?? "default";
  const wanted = (requestedProfile ?? "").trim();
  if (wanted && wanted !== profile) {
    return (
      <MobileShell title="Chat">
        <SwitchOnArrival profile={wanted} current={profile} />
      </MobileShell>
    );
  }

  let sessions: SessionSummary[] = [];
  let sessionId: string | null = null;
  let messages: ChatMessage[] = [];
  let error: string | null = null;
  try {
    const client = await apiClientForRequest({ profile });
    // Every conversation: the strip groups them into categories, and a
    // recent-first page cap would empty the older end of each category.
    const list = await client.allSessions({ order: "recent" });
    sessions = list.sessions;
    if (freshChat) {
      sessionId = null;
    } else if (requested && sessions.some((s) => s.id === requested)) {
      sessionId = requested;
    } else if (sessions.length > 0) {
      sessionId = sessions[0].id;
    }
    if (sessionId) {
      const transcript = await client.sessionMessages(sessionId);
      messages = transcript.messages;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load conversations";
  }

  return (
    <MobileShell title="Chat" fill actions={error ? null : <ChatHeaderActions />}>
      {error ? (
        <div
          data-component="ChatError"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]"
        >
          Couldn&apos;t load your conversations ({error}).
        </div>
      ) : (
        <ChatPane
          initialSessions={sessions}
          initialSessionId={sessionId}
          initialMessages={messages}
          storageEnabled={storageConfigured()}
          profile={profile}
          initialDraft={(draft ?? "").trim() || undefined}
          autoSend={freshChat && autosend === "1"}
        />
      )}
    </MobileShell>
  );
}
