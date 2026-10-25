---
name: vibe-code-app
description: "Use when a user asks you to build or change an app (web UI + database) in chat. One hosting question, an FG-32 Project, coder cards on the app's dev branch, a /apps-dev preview, then promote."
version: 1.0.0
author: Leo Lau (@leolau), Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [apps, vibe-coding, nextjs, supabase, kanban, projects, dev-prod, mcp]
    category: software-development
    related_skills: [create-in-house-tool, projects, promote-artifact]
---

# Vibe-Code App Skill

Turn "build me an app that..." into a running app the user can open and the
agent can call. Every app is a Next.js + Supabase project from the
`nextjs-supabase` template, with its own database, a web UI and an MCP endpoint
(`/api/mcp`). It is built by coder profiles on kanban cards inside an FG-32
Project, previewed on the dev instance and then promoted.

Two hostings (FG-33):

| | Local (default) | External |
|---|---|---|
| Runs on | this Aquarium box, its own Node process | a provider (Vercel + supabase.com by default) |
| Dev preview | `/apps-dev/<slug>` | the provider's preview URL |
| Prod | `/apps/<slug>` | the provider's production URL |
| Default coder profile | `internal-coder` | `external-coder` |

## When to Use

- The user wants a new app, dashboard, form, tracker, internal site or "tool
  with a UI" built for them.
- The user wants to change, fix or extend an app that already exists
  (see "Later changes").

Do not use this for a one-off script, a document, or a new *core* model tool.
For the registry chores themselves (enable/disable/config of an existing
tool) see **create-in-house-tool**.

## Rules

1. **Ask exactly one question: where it runs.** Use `clarify` once, with
   **Local** as the first (pre-selected) choice. Pre-select **External** only
   when the user mentioned a public URL, a custom domain, heavy traffic/scale,
   or a provider by name (Vercel, Railway, AWS Amplify, Alibaba Cloud FC,
   supabase.com). Don't run a requirements interview. Write the open details
   into the Project description and the cards, and let the preview settle them.
2. **Propose the Project; the human creates and activates it.** Follow the
   **projects** skill. Never activate a project, accept an output or score a
   run yourself.
3. **Build cards go to the coder profile, not to you.** Assign every build card
   to the profile `coder_profile_for` gives: the tool's `coder_profile` if one is
   set on its row (Tools page → app sheet), else `internal-coder` for local and
   `external-coder` for external. Never hard-code another profile, and never
   build the app in your own chat turn.
4. **Work happens on `dev`.** The app's git repo has a `dev` branch. Cards commit
   there. The prod release is only ever produced by promotion.
5. **One prod and one dev process per app.** `hermes tool build <slug>` starts
   the dev instance on demand. It is idle-stopped after about 20-30 minutes and
   comes back on the next build or open. Never leave `npm run dev`,
   `next start` or any other server running from a shell. Nothing outside the
   app's own unit may serve it.
6. **Members need no approval to act inside their limits.** Create, build,
   preview, promote, share and archive happen without a C6 approval request.
   Quotas (`hermes tool doctor`, the "App limits" settings) are the limit. If a
   command is refused for quota, tell the user which limit was hit and that an
   owner/admin can raise it. Don't retry in a loop.
7. **Irreversible data loss gets exactly one explicit confirmation.** Purge,
   database drop and remove are the user's action, behind one typed or dialog
   confirmation (the Tools page button carries `data-appmcp-deny`, so no agent
   or app MCP call can press it). Don't run or simulate those steps. Point the
   user to the button. Don't stack a second "are you sure" on top of it.
8. **Prompt caching is sacred.** A new or rebuilt app's MCP tools
   (`mcp_la_<slug>_*`) surface in the **next** chat, never mid-conversation.
   Say so. Don't try to reload tools, edit config or restart the gateway to
   make them appear now.
9. **Secrets stay out of source and chat.** No `.env*` files in the repo, and no
   keys in `NEXT_PUBLIC_*` or client code. Provider and API keys go through the
   app's secrets UI. Non-secret settings go in the app's config, never in a new
   `HERMES_*` env var.

## Procedure (new app)

1. **Intake.** Restate the app in one sentence, list the main screens/data, and
   pick a slug. The slug is lowercase, starts with a letter, uses `a-z0-9-`,
   and has at most 40 chars. Ask the hosting question (rule 1). If the user
   chooses External with no provider, use Vercel + supabase.com.
2. **Project.** Propose the FG-32 Project with the declared output
   `running app v1` (kind `code`). Use the user's words for the goal. The
   description should list the screens, the data, who uses it and the hosting
   choice:

   ```bash
   hermes projects create "Team lunch-order app, running and shared" --description brief.md --output "running app v1" --cadence one_off
   ```

   It lands in `planning`. The human activates it on the Projects page. If
   your shell refuses `hermes projects`, post the same proposal in chat and
   ask the user to create it there. Don't skip the Project.
3. **Scaffold.** For local:

   ```bash
   hermes tool new <slug> --template nextjs-supabase --hosting local
   ```

   For external, pass the provider the user chose (default `vercel`):

   ```bash
   hermes tool new <slug> --template nextjs-supabase --hosting external --provider vercel
   ```

   Read the printed `path:` (the app source, `$HERMES_HOME/tools/<slug>`), the
   `preview:` path and the MCP endpoint. Add `--shared` only if the user asked
   for a team app. Link the app to the Project so it is one click away:

   ```bash
   hermes projects link <project> --kind url --ref /apps-dev/<slug> --label "<slug> (dev preview)"
   ```
4. **Cards.** Read the Project's board (`board_slug` from
   `hermes projects show <project> --json`). Create one card per
   reviewable slice, such as data model + migrations, the main screen, the MCP
   tools and the auth/sharing rules. Each card's workspace is the app source:

   ```bash
   hermes kanban --board <board> create "Main order screen" --assignee <profile> --workspace dir:<path> --body "<the slice, then the definition of done below>"
   ```

   `<profile>` comes from rule 3 and `<path>` is the scaffold `path:`. Use
   `--parent` when one slice must land before another. Every card body ends
   with this **definition of done**:

   - `npm ci && npm run check` passes in the app directory. That covers
     typecheck, lint, the tests including the MCP
     `initialize → tools/list → tools/call` handshake test, the audit and the
     build.
   - `hermes tool build <slug>` succeeds and `hermes tool status <slug>` shows
     the dev instance running. Any new MCP tool answers that same handshake
     against the dev instance.
   - A browser screenshot of the dev preview (`/apps-dev/<slug>` for local) is
     attached to the card.
   - The change is committed on the app's `dev` branch, with no `.env*` files
     and no secrets.
5. **Preview.** When the cards are done, rebuild with `hermes tool build <slug>`
   and give the user the dev preview. For local that is
   `https://<aquarium host>/apps-dev/<slug>`, which `hermes tool preview <slug>`
   prints. Tell them the preview sleeps when idle and wakes on the next build.
   Its MCP tools reach chats in a new chat (rule 8).
6. **Feedback.** Feedback on a card that is still running becomes a comment on
   it (`hermes kanban comment <task-id> "<feedback>"`). Otherwise record it on
   the Project for the next run
   (`hermes projects guidance <project> add "<feedback>" --kind feedback`) and
   open a follow-up card.
7. **Promote.** Promote only after the user explicitly signs off on the
   preview:

   ```bash
   hermes tool promote <slug>
   ```

   If the command still shows an approval prompt, that prompt is the user's
   sign-off. Don't ask them a second time.

   For local apps, prod is then at `/apps/<slug>` and stays up while dev keeps
   changing. Deliver the Project output with that URL as the ref. The human
   accepts it:

   ```bash
   hermes projects outputs <project> deliver "running app v1" --ref /apps/<slug>
   ```

## Later changes

1. Read the app's registry row (`hermes tool status <slug>`) and the Project's
   guidance, last retro and score (`hermes projects show <project>`).
2. Start a new Project run (`hermes projects run <project>`) or ask the user to
   start it, then create cards for the change exactly as in step 4. They go on
   `dev`, with the same assignee rule and definition of done.
3. Preview on the dev path, get the user's sign-off and promote again. Never
   edit the prod release or its database directly.

## Pitfalls

- External needs the provider credentials in the app's secrets. If the deploy
  step isn't available yet, or the provider refuses it, say so and offer Local.
  Don't fall back silently.
- A preview that redirects to the Aquarium login is working as intended.
  Apps sit behind the same sign-in. Don't bypass it.
- If `hermes tool build` fails, read `hermes tool logs <slug> --mode dev` and fix
  the app on a card. Don't patch the runtime, units or helpers.
- `hermes tool doctor --json` shows quota, disk and process headroom. Check it
  before promising a new app when the box is busy.
- OpenCode-style editors that write files outside Aquarium's file tools are
  opt-in only. Not the default.

## Verification

- `hermes tool list` shows the app, and `hermes tool status <slug>` shows the dev
  instance (and after promotion, prod).
- Each build card carries a passing `npm run check`, a dev-preview screenshot and
  a `dev` commit.
- `/apps-dev/<slug>` (and after promotion `/apps/<slug>`) opens for the user.
  In a new chat, `mcp_la_<slug>_*` tools are listed.
