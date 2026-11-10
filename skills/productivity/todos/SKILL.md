---
name: todos
description: "hermes todos CLI: read, add, promote, finish, and send the replies an approval authorized."
version: 1.0.0
author: core
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [To-dos, Productivity, Triagedecisions, CLI]
---

# To-dos

The to-do list is the staging layer between what arrives and what gets done.
Triage extracts action items from arrivals; `hermes todos` is the operator
surface — the CLI the agent uses to read, add, promote, and finish them
without going through the web page or the HTTP API.

## Commands

```
hermes todos [--actor <user>] <verb> …

hermes todos list    [--stage staged,open,working] [--priority high] [--q TEXT] [--json]
hermes todos show    <id>                    # + history + the source arrival
hermes todos add     "<title>" [--why TEXT] [--priority p] [--due YYYY-MM-DD] [--stage staged|open] [--json]
hermes todos stage   <id> <stage> [--outcome TEXT] [--json]
hermes todos start   <id> [--session] [--actor <user>] [--json]  # move to working, optionally spawn
hermes todos done    <id> [--outcome TEXT] [--propose-reply] [--json]
hermes todos snooze  <id> --until <when> [--json]
hermes todos facets  [--json]
hermes todos expire  [--days 14] [--dry-run] [--json]
hermes todos send    <id> --channel <c> --to <t> [--account A] [--thread T] [--json]
hermes todos backfill --since <date> [--dry-run] [--json]
```

Every read verb accepts `--json` for machine-readable output. The agent
parses JSON; the human reads the table. One flag, both audiences.

Every to-do has a short ref users type in prompts (`D88`, FG-36). Resolve one
with `hermes ref D88 [--json]` — it prints the to-do's id (for the verbs
above), title, stage and profile, or "ref not found" for a to-do the actor may
not see. Quote the ref back to the user instead of the UUID.

## Rules

These four rules keep the page from becoming noise. A model that can write
rows in a loop is exactly the failure mode they exist to prevent.

### 1. A to-do is a decision for the user, not a note to self

In-session planning stays in `tools/todo_tool.py`. If nobody needs to decide
anything, it is not a to-do. Do not capture "investigate X" or "look into Y"
— those are tasks, not to-dos. A to-do is something the user must act on:
reply by Friday, approve this invoice, call this person back.

### 2. Before spending a model call on unrequested work, create the to-do first

If the user asked you to do something that will take several turns or involve
outgoing actions (sending a message, making a decision), create the to-do
**before** starting the work. This way the user can see what you are doing
and intervene. The to-do is the user's handle on your work.

### 3. `staged` by default from an agent

Only the user's own request, or an explicit deadline, justifies `open` (which
notifies). The agent does not get to ring the bell. When you create a to-do,
default to `--stage staged` unless the user explicitly asked for it to be
actionable now.

### 4. One to-do per decision

Check `hermes todos list --q "<keyword>"` before adding. The store's
partial-unique index will collapse an exact duplicate, but a near-duplicate
with a reworded title will not be caught by the store and must be caught here.
When in doubt, search first.

## Sending approved replies

`hermes todos send` delivers an outgoing action that was already approved
through FG-10. The body comes from the approval row — never from the command
line. The routing (`--channel`, `--to`, `--account`, `--thread`) must match
what was approved. A pending or denied approval refuses.

You do not decide what to send. The user approved it; you are the delivery
path.
