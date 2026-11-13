---
title: "feat: Continue chip under the landing greeting"
status: implemented
date: 2026-11-13
type: feature
target_repo: aquarium (agent-home)
---

# Continue chip under the landing greeting

## Ask

On the landing page, surface a "Continue" affordance — with the chat
session's title — directly below the "N things need you" subline, so the
user notices the chat to pick up and can resume it in one tap instead of
scanning the sidebar.

## What already existed (verified 2026-11-13)

- The chats sidebar already computes "the chat to continue":
  `latestSession` over the user-started (`agent_home` source, non-archived)
  chats in `ChatsPanel` (`highlightLatest`), and `SessionRow` marks it with
  an accent outline + a "Continue" badge.
- `GET /api/chat/sessions?limit=100&source=agent_home` is served through
  the shared coalescing fetch (`session-list-fetch.ts`), which joins
  in-flight requests and reuses results younger than 2 s per URL.
- `LandingClient.openSession` opens a chat inline in the centre column
  (`/?chat=<id>` history push); sidebar rows use the same path for plain
  clicks.

## Change

- New hook `agent-home/src/components/landing/chats/useResumeChat.ts`:
  returns `latestSession` over `isUserStartedChat`-filtered sessions. Reads
  the same coalesced endpoint the sidebar does (same URL → joins its
  in-flight fetch, no extra request on mount), forces a re-read on
  `aquarium:chat-sessions-changed` (post-mutation semantics), and re-reads
  on focus/visibility like `useLandingChats`. Failures keep the last good
  data — the chip just stays hidden.
- `LandingComposer.tsx`: a `ContinueChip` under the subline — the accent
  Continue pill (same styling as `SessionRow`'s badge), the chat's
  `displayTitle` (untitled previews render italic muted, same as the
  sidebar), and `lastUpdated`'s relative label with the full timestamp as
  the tooltip. New optional prop `onOpenChat`; without it the chip routes
  to `/chat?session=<id>` via `chatHref`.
- `LandingClient.tsx`: passes `onOpenChat={openSession}` so the chip opens
  the chat inline like a sidebar click does.

## Verification

- `npx vitest run` on `LandingComposer.test.tsx`, `LandingClient.test.tsx`,
  `ChatsPanel.test.tsx` — 41/41 pass.
- `npm run typecheck` — clean; `eslint` on touched files — clean.
- New tests cover: chip shows the latest non-archived user chat's title,
  click calls `onOpenChat` (no router push), fallback navigates to
  `/chat?session=…`, chip hidden with an empty list. The existing
  "hands the message to a fresh chat on Enter" test's `fetch` assertion was
  narrowed to the profile-switch POST because the hook now reads the
  session list on mount.
