---
name: projects
description: "hermes projects CLI: read, create, link, and run Projects — multi-sitting work with cadence, a playbook and a record."
version: 1.0.0
author: core
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Projects, Productivity, Runs, CLI]
---

# Projects

A project is work that survives more than one sitting — it has a goal, a brief,
declared outputs, a playbook, and a record of every run. `hermes projects` is
the operator surface: the CLI the agent uses to read and shape that record
without going through the web page or the HTTP API. `hermes project`
(singular) is the folder-workspace command and stays separate.

## Commands

```
hermes projects [--actor <user>] <verb> …

hermes projects list      [--status s] [--cadence c] [--health h] [--archived] [--json]
hermes projects show      <slug> [--json]
hermes projects create    "<goal sentence>" --description <file.md|-> --output "<title>"
                                 [--name "<short label>"] [--cadence one_off|repeatable|standing]
                                 [--host-profile p] [--audience "…"] [--goal-id <id>] [--json]
hermes projects link      <slug> --kind file|arrival|todo|goal|memory|conversation|url|sample|reference
                                 --ref <id> [--profile <p>] [--label "…"] [--json]
hermes projects outputs   <slug> [list|add "<title>" [--spec s] [--optional] [--recurring]
                                 |deliver <id> --ref <r> [--note "…"] |accept <id>] [--json]
hermes projects contacts  <slug> [list|add "<name>" [--role r] [--platform p] [--address a]] [--json]
hermes projects tools     <slug> [show|set --toolsets a,b --skills x,y] [--json]
hermes projects score     <slug> <run_no> <1-5> [--note "why that score"] [--json]
hermes projects members   <slug> [--add <user> --role lead|member|viewer] [--json]
hermes projects cards     <slug> [--status s] [--json]
hermes projects card add  <slug> "<title>" [--assignee <profile>] [--from-todo <id>] [--json]
hermes projects playbook  <slug> [show|save <file.json> [--note "…"]|activate <rev> [--note "…"]] [--json]
hermes projects guidance  <slug> [list|add "<body>" [--kind directive|feedback]|retire <id>|activate <id>] [--json]
hermes projects run       <slug> [--trigger schedule|manual|event|review]
                                 [--playbook-rev N] [--dry-run] [--json]
hermes projects runs      <slug> [--limit 10] [--json]
hermes projects retro     <slug> <run_no> [--write] [--propose KIND=BODY]… [--json]
hermes projects summarise <slug>          # rolling "where this stands" — reads stdin
hermes projects doctor    [--slug s] [--json]
```

Every read verb accepts `--json` for machine-readable output. The agent parses
JSON; the human reads the lines. One flag, both audiences.

`hermes projects create` refuses without goal, description, at least one
declared output and a host profile, and `--description -` reads stdin — a
mandatory long brief typed as a shell argument is a brief nobody writes.

`hermes projects run` is the load-bearing verb: it is what the cron job calls,
and the only place that compiles guidance, instantiates the playbook and opens
a run row. `--dry-run` prints the cards it *would* create and the compiled
guidance block — the single most useful thing a user can do before turning a
schedule on.

Guidance added with `guidance add` applies **from the next run**, never the
current one — say so when you add one. The list is capped; when it is full,
retire one first.

A retro may carry up to three concrete proposals (`retro … --write --propose
KIND=BODY`, KIND = playbook | directive | skill) — what a run learnt (§8.2).
Every proposal lands **inactive**: a playbook revision waits for a lead/admin
to activate it, a directive waits for any member (`guidance activate <id>`),
and a skill proposal is recorded as a candidate with this project and run as
its provenance. Nothing on the learning path is automatic — propose, never
cross.

`hermes projects summarise <slug>` writes the rolling "where this stands"
from stdin — one or two sentences a human actually reads, overwritten each
time, never appended. Do it when you close a run: the summary is what a
user sees before anything else on the project.

## Rules

These rules keep the record from becoming noise. A model that can write rows
in a loop is exactly the failure mode they exist to prevent.

### 1. A project is for work that spans sittings, people or profiles

One decision is a to-do (`hermes todos`); in-session planning is
`tools/todo_tool.py`. If the work fits in one sitting and involves nobody
else, it is not a project.

### 2. Propose, don't create

The agent may propose a project, a playbook revision or a directive; the human
creates and activates. A new project starts in `planning` — activation is a
human act on /projects.

### 3. Link, never copy

Everything a project gathers — files, arrivals, to-dos, goals, memories,
conversations, samples — is a pointer. A link whose target disappears renders
from its cached label as "no longer available"; never paste content into the
record.

### 3b. Declare the output before doing the work — accepting it is never yours

`outputs add` is proposable by the agent; `outputs accept` will refuse you
("accepting an output is a human act — no verified session"). Deliver what
you made — `outputs deliver <id> --ref <where it lives>` — then ask the user
to accept it. A run that produced nothing must close `no_output` rather than
narrate effort.

### 4. Human acts refuse you — checkpoints, activation, autonomy

These are enforced, not conventions: `guidance activate`, `playbook
activate`, `score` and `outputs accept` all answer a session-less caller
with a 403, and a checkpoint card holds its successors until a human
releases it. Your move when a project needs one of these is to ask the user,
never to claim `--as-human` yourself — that flag is the operator's, for the
moment they are making the judgement in person. Autonomy only ever moves
down from `supervised`, and only with the user's explicit say-so.

### 5. Read the last run's retro and score before starting work

That is what the record is for. `hermes projects runs <slug>` then
`hermes projects retro <slug> <run_no>` — a low score with a note is the most
specific instruction the project has. Scoring a run
(`score <slug> <run_no> <1-5>`) is human-only and will refuse you; if the user tells you their
score, pass exactly their judgement through with `--as-human` — never score
on your own say-so, and a `≤2` with a note is what teaches the project most.

### 6. A project's `toolsets`/`skills` can only narrow what the profile allows

The filter is an intersection, never a grant. If a run needs a tool the host
profile does not enable, that is an ask to the user, not a project edit.
`tools set` reports what was dropped — read it before you move on.

## Failure checks

`hermes projects doctor` surfaces the diagnosable breaks: a schedule whose
cron job is gone, a repeatable that stopped firing, links that no longer
resolve. Run it when something looks stale before assuming the project is
broken.
