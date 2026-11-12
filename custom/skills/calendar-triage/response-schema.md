---
name: response-schema
description: >
  JSON response contract for calendar triage. Edit this file to change what
  the LLM returns for each calendar event.
---

# Response Format

You MUST respond in this exact JSON format for each event:

```json
{
  "importance": "critical|normal|low",
  "importance_reason": "brief explanation of the classification",
  "escalate": true,
  "escalation_reason": "conflict|critical_event|deadline|null",
  "escalation_priority": "high|medium|low",
  "conflicts": [
    {"type": "hard|soft|location|cross_account", "event_a": "...", "event_b": "...", "overlap_minutes": 30}
  ],
  "prep_notes": "what to prepare before this meeting",
  "todos": [
    {"title": "imperative, specific action", "detail": "one or two sentences of context", "priority": "high|medium|low", "due_date": "YYYY-MM-DD or null", "notify": false}
  ],
  "work_request": {
    "title": "imperative, specific work item or null",
    "instructions": "what the agent should produce, detailed enough to act without seeing this event",
    "deliverable": "what 'done' looks like — e.g. briefing notes and a reply draft",
    "auto_start": false,
    "priority": "high|medium|low",
    "due_date": "YYYY-MM-DD or null"
  },
  "memory_facts": [
    {"fact": "self-contained factual statement", "category": "contact|preference|decision|project|financial"}
  ]
}
```

## Field notes

- `importance` — see classify-importance.md for criteria
- `conflicts` — only include if conflicts were detected (see detect-conflicts.md)
- `prep_notes` — relevant preparation context (see extract-prep-context.md)
- `todos` — preparation or follow-through the user must do personally,
  shown on the To-dos page; `notify` decides whether it interrupts them.
  See todo-decisions.md; at most three per event are recorded.
- `memory_facts` — meeting patterns or contact relationships worth remembering
  (see remember-decisions.md)
- `escalate` — true for hard conflicts or critical events starting soon
- `work_request` — the *most important* items only: real work the agent should
  do, not just a reminder. `null` (or omitted) for most events. Unlike a
  `todos` entry this is for output the agent produces — prep notes, a drafted
  reply. `instructions` must stand alone. `auto_start` true asks the system to
  begin immediately — reserve it for items the user has previously said should
  be handled automatically; when false the to-do waits for "Work on this".
