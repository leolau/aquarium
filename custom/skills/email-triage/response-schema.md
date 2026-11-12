---
name: response-schema
description: >
  JSON response contract for email triage. Edit this file to add, remove, or
  rename fields the LLM returns. The Python processing layer handles any field
  that has a registered handler; unhandled fields are logged and ignored.
---

# Response Format

You MUST respond in this exact JSON format. Include every field listed below.
Use empty arrays or null values when there is nothing to extract for a field.

```json
{
  "classification": "urgent_business|meeting|task|invoice|sales_opportunity|informational|newsletter|notification|personal|spam",
  "summary": "brief 1-2 sentence summary of the batch",
  "escalate": true,
  "escalation_reason": "family|vip_sender|urgent_business|sales_opportunity|invoice|client_email|null",
  "escalation_priority": "high|medium|low",
  "tasks": [
    {"description": "...", "due_date": "YYYY-MM-DD or null", "priority": "high|medium|low"}
  ],
  "todos": [
    {"title": "imperative, specific action", "detail": "one or two sentences of context", "priority": "high|medium|low", "due_date": "YYYY-MM-DD or null", "notify": false}
  ],
  "work_request": {
    "title": "imperative, specific work item or null",
    "instructions": "what the agent should produce, detailed enough to act without seeing this email",
    "deliverable": "what 'done' looks like — e.g. a quotation draft and a reply draft",
    "auto_start": false,
    "priority": "high|medium|low",
    "due_date": "YYYY-MM-DD or null"
  },
  "notes": [
    {"content": "..."}
  ],
  "memory_facts": [
    {"fact": "self-contained factual statement", "category": "contact|preference|decision|project|financial"}
  ]
}
```

## Field notes

- `classification` — pick exactly one category from classify-emails.md
- `escalate` — boolean; true means push to user immediately
- `escalation_reason` — null when escalate is false
- `tasks` — action items; each needs at minimum description and priority
- `todos` — the subset worth showing the user on the To-dos page, with
  `notify` deciding whether it interrupts them. Most batches produce none.
  See todo-decisions.md; at most three per batch are recorded.
- `work_request` — the *most important* items only: real work the agent should
  do, not just a reminder. `null` (or omitted) for most batches. Unlike a
  `todos` entry this is for output the agent produces — a quotation, a drafted
  reply, research. `instructions` must stand alone: the working agent sees the
  source email plus this text, nothing else. `deliverable` names what the user
  will review. `auto_start` true asks the system to begin the work immediately
  instead of waiting for the user — reserve it for items the user has
  previously said should be handled automatically (e.g. quotations for known
  request patterns); when false the to-do waits for "Work on this".
- `notes` — info worth saving in the local DB (not long-term memory)
- `memory_facts` — facts to persist to agent long-term memory. See
  remember-decisions.md for criteria. Each fact must be self-contained.
