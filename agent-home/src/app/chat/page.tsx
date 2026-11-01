import { ChatHeaderActions } from "@/components/chat/ChatHeaderActions";
import { ChatPane } from "@/components/chat/ChatPane";
import { MobileShell } from "@/components/MobileShell";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { storageConfigured } from "@/lib/env";
import type { ChatMessage, ProfileSummary, SessionSummary } from "@/types";

/** The profile the chat addresses when the URL names none. */
const DEFAULT_PROFILE = "default";

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
  searchParams: Promise<{ session?: string; profile?: string; draft?: string }>;
}) {
  await requirePrincipal();
  // `?session=<id>` is where a memory's citation link lands. `?profile=<name>`
  // is which profile the chat addresses (FG-28) — a whole HERMES_HOME, so it
  // selects the brain that answers *and* the conversations shown.
  // `?draft=<text>` pre-fills the composer (a project's "ask the agent to
  // draft a plan" door) — nothing is sent until the user presses send.
  const {
    session: requested,
    profile: requestedProfile,
    draft,
  } = await searchParams;
  const profile = (requestedProfile ?? "").trim() || DEFAULT_PROFILE;

  let sessions: SessionSummary[] = [];
  let sessionId: string | null = null;
  let messages: ChatMessage[] = [];
  let profiles: ProfileSummary[] = [];
  let error: string | null = null;
  try {
    const client = await apiClientForRequest({ profile });
    // `profiles()` and `sessions()` don't depend on each other — awaiting
    // them sequentially was pure added latency on every page load.
    const [profilesResult, list] = await Promise.all([
      // A profile that no longer exists must not silently answer as the
      // default: the list is what the picker offers, and an unknown name
      // 404s upstream.
      client.profiles().catch(() => ({ profiles: [] })),
      // Every conversation: the strip groups them into categories, and a
      // recent-first page cap would empty the older end of each category.
      client.allSessions({ order: "recent" }),
    ]);
    profiles = profilesResult.profiles;
    sessions = list.sessions;
    if (requested && sessions.some((s) => s.id === requested)) {
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
          profiles={profiles}
          profile={profile}
          initialDraft={(draft ?? "").trim() || undefined}
        />
      )}
    </MobileShell>
  );
}
