# Busy buttons — every button that calls the server shows it is working and can't be clicked twice

Requested by Leo, 2026-10-20 (approved; "do them one after another"):

> Whenever a button is clicked two things should happen: 1) the button should
> indicate to the user that it is processing; 2) the same button should be
> blocked from user clicking it again.

**Next agent: start at "Progress" below, take the first row that is not done,
and update this file in the same PR.** Each area PR goes into `develop`, one at
a time (Leo merges; rebuild the next PR on the merged `develop`).

## The building blocks (PR 1)

- `agent-home/src/lib/use-action.ts` — `useAction(fn)` returns `{ run, pending }`.
  A ref lock is taken synchronously on the first call, so a fast double-click
  or double Enter calls `fn` once (React's `disabled` only lands after the next
  render, which a fast double-click beats). `pending` drives the busy look.
- `agent-home/src/components/ui/ActionButton.tsx` — the one button for server
  work. `onAction` runs through `useAction`; while busy it shows `Spinner` plus
  `busyLabel` (default `common.working` = "Working…" / "處理中…"), is
  `disabled`, sets `aria-busy`, and drops clicks. For forms: run the submit with
  `useAction` in `onSubmit` and pass `busy={pending}` to a `type="submit"`
  `ActionButton`.
- Guard test `agent-home/src/components/ui/busy-button-guard.test.ts` — any
  `.tsx` under `src/components` or `src/app` that sends POST/PUT/PATCH/DELETE
  must import `ActionButton` or `useAction`. Its `PENDING` list holds the files
  not converted yet, grouped by area PR; remove a file from it when you convert
  it (the test fails if a listed file is already converted or no longer sends).

## How to convert a component

1. Every button whose click calls the server (directly, through a helper such
   as `call()`, or through `router.refresh()` after a write) becomes an
   `ActionButton` with a specific `busyLabel` ("Saving…", "Testing…",
   "Sending…"), in EN and 繁中 in that area's messages file.
2. Keep any existing view-level `busy` flag: pass it as `busy` so sibling
   buttons stay blocked while one runs, and keep `BusyRegion` where present.
   Hold busy across `useRefresh().refreshing` if the view refreshes after a write.
   For a view with one shared `busy` (several buttons, one request at a time),
   wrap its request in one lock: `const { run: exclusive, pending: busy } =
   useAction((work: () => Promise<void>) => work())`, then each button is
   `<ActionButton disabled={busy} onAction={() => exclusive(() => post(...))}>`.
   Callbacks passed to child cards: `onX={(a) => exclusive(() => x(a))}`.
3. Forms: `useAction` around the submit; Enter must not send twice.
4. Buttons that only load data (Load more, Refresh, Search, Open file) also get
   a busy state and lock — the guard only checks writes, so review by hand.
5. Purely local buttons (Cancel, Close, Copy, tab switches) stay as they are.
6. Add or update a test for the area: double-click sends once; the button shows
   the busy label and is disabled until the server answers.
7. Run `npx tsc -p . --noEmit`, `npx eslint <files>`, `npx vitest run <area>`.

## Progress

| PR | Area | Files (from the guard's PENDING list + GET-only buttons) | Status |
|---|---|---|---|
| 1 | Building blocks + guard | `use-action.ts`, `ActionButton.tsx`, guard test | merged: https://github.com/leolau/aquarium/pull/606 |
| 2 | Chat, Inbox, To-dos | chat/ChatPane, Composer, ArchivedModal, SessionModal, SessionSearchBar, MessageBubble; inbox/InboxView, IncomingDetailView, IncomingsList; todos/TodoCompleteForm, TodoDetailView, TodosList | PR open: https://github.com/leolau/aquarium/pull/607 (also converted ApprovalsList, ChangesList, TodoRow, ArchivedModal, SessionModal, SessionSearchBar, ApprovalModal, ApprovalCard; tests in `chat/busy-buttons.test.tsx`) |
| 3 | Projects | all `components/projects/**` in PENDING, plus AddToProjectSheet, ProjectsList, changes/ChangeRequestSheet, panels/GuidancePanel, ask/AskOrChangeBox, dashboard/DashActionButton | PR open: https://github.com/leolau/aquarium/pull/608 (tsc, eslint, 753 projects+ui tests green; new `projects/busy-buttons.test.tsx`). Finding: Projects already has `useProjectAction` (ref lock + idempotency key + refresh) and `projects/ActionButton` (busy + pendingLabel). So PR 3 = guard accepts `useProjectAction`, plus convert the few raw buttons left (CardEditor save, NewProjectForm finish/submit, InputRow open/retry, OutputsPanel open file, ProjectsList Load more, ChangeRequestSheet, AddToProjectSheet, PlanPanel). Converted: ProjectsList Load more, GuidancePanel "Show retired", NewProjectForm "Go to the project without them", InputRow + AddToProjectSheet Retry. Checked and already fine: CardEditor/PlanPanel/ChangeRequestSheet (remaining raw buttons are local: Cancel, add/remove step, kind chips), DashActionButton "Try again" (goes through `useProjectAction`). Left for PR 6 (Files): file-open links in InputRow/OutputsPanel use `files/FileRefOpener` |
| 4 | Settings, People | all `components/settings/*` in PENDING, plus users/UsersView, InvitationLink, DirectoryPanel | in progress on branch `devin/1792543072-busy-settings-people` (12 settings files from PENDING). Approach: (1) `ui/ConfirmDialog` confirm button becomes an `ActionButton` with `onConfirm(): unknown`, so every confirm (settings, NetworkFolders, Logout, Backups, Users) is locked; callers return the promise instead of `void`. (2) In each settings file, server buttons become `ActionButton` with `onAction` (no `void`, so the lock lasts until the request ends); child prop types `() => void` become `() => unknown`. Local buttons (Cancel, Edit form open, Copy, show QR, opening a confirm) stay plain. Status: code converted in all 12 settings files + ConfirmDialog; forms (EmailMailboxes, TelegramBotSetup, TelegramLinks, PersonalMcp add form) lock their submit with `useAction`; tsc + eslint clean; PENDING cleared for settings. Still to do: users/UsersView, InvitationLink, DirectoryPanel check, a test, then PR |
| 5 | Sign-in, first-run, Account, Get ready | LoginForm, LogoutButton, LanguageSwitch, auth/*, get-ready/*, account/* (TwoFactorSetup, RecoveryCodes, AccountSecurity), push/PushEnroll | not started |
| 6 | Files, Memory, Models, other | files/BrowseView, NetworkFolders, FolderBridgeView, FilesView, FileRefOpener; memory/MemoryView; models/ModelsView, ModelPickerSheet; profiles/ProfileSuggestionsView; coral/LeadChatHost; webview/WebviewConsole; ui/StatusStrip | not started |
| 7 | Deploy to Hetzner | normal `/opt/data/deploy-hermes.sh develop` after a backup + snapshot (see aquarium-ops `production/PRODUCTION.md`); no settings change | not started |

Audit numbers at the start (2026-10-20, `develop` 840ce6da9): 59 components send
changes or load on click; 38 had a server button with no `disabled`; 52 had no
lock against a fast double-click.
