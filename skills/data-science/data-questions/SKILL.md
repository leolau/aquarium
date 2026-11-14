---
name: data-questions
description: "Answer questions from Supabase data using the dictionary."
version: 1.0.0
author: Leo Lau (leolau), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Data, SQL, Database, Dictionary, Supabase]
    related_skills: [site-to-schema]
---

# Data questions

Use this when someone asks a question that needs numbers or rows from data
Aquarium holds: a site's tables (site-to-schema), or their own to-dos, goals,
files and inbox. Everything goes through the `site_db` tool, which runs as the
person asking: they only ever see rows they may see.

## Answer a question

1. **Pick the source.** A site's data → `source` = the site slug
   (`list_sites`). Their own Aquarium data → `source` = `app`.
2. **Read the dictionary**: `site_db action=dictionary source=…`. It says
   what each table and column means, the grain, the joins and the agreed
   metric definitions. Use those definitions; never invent a different one for
   a metric it defines. If you get an error or nothing is approved, carry on
   from the structure and say in your answer that the tables aren't described.
   **Stale entries**: when the source shows `schema_drift`, the schema changed
   since the dictionary was approved — entries marked `stale` may no longer
   match (a removed column, new columns still undocumented). Warn the person
   when answering from stale text, and offer to update it: `study` the drifted
   tables, then `propose_dictionary` once they agree.
3. **Look before you write SQL**: `describe` (site, entity?, q?) for a site,
   `app_describe` for app data. Check column names, fill and common values.
4. **Ask when it's unclear.** If the question could mean two things (which
   date, which status counts as "done", gross or net), ask one short question
   instead of guessing.
5. **Run one SELECT**: `query` (site, sql) or `app_query` (areas, sql); in
   app data each area is a table named after it (`todos`, `goals`, `files`,
   `inbox`). Results stop at 500 rows: if `truncated` is true, aggregate in SQL
   or say the list is cut off. Never page through raw rows to count them.
6. **Answer**, then in one line: the source, the dictionary version used
   ("dictionary v3", or "no dictionary yet") and the SQL in a code block.
7. **End the message with a `data-answer` block** so agent-home can show the
   source, Show SQL and "Was this right?" under the answer (it hides the block):

   ```data-answer
   {"source_id": "<source.id>", "source": "<source.name>", "version": 3,
    "tables": ["shipments"], "question": "<the person's question>",
    "sql": "<the SQL you ran>", "undescribed": []}
   ```

   `version` is null with no approved dictionary; `undescribed` lists the
   tables you used that have no entry. One JSON object, nothing after it.

## Improve the dictionary

Only the source's owner approves; you only add to the draft.

- **The person teaches you** ("revenue excludes refunds"): offer to save it,
  and on yes call `propose_dictionary` with `origin=chat` and that table's
  whole entry (read it first, change only what they said).
- **They confirm an answer is right**: offer to save the question and SQL as a
  verified example (`origin=feedback`, the table's `examples`). In agent-home,
  "Yes, save as example" under the answer does this without you.
- **They correct an answer** (or say "No, correct it"): fix the answer, then
  offer to fix the definition with `origin=feedback`.
- **"Build dictionary" / "describe these tables"**: call `study`, draft an
  entry per undescribed table (meaning, what one row is, grain, column notes,
  joins, metrics), ask about anything you can't tell from the data, then one
  `propose_dictionary` with `origin=study`.

After proposing, say that the draft waits for the owner's approval under Data
in agent-home, and that answers keep using the approved version until then.
Never propose without the person asking or agreeing.
