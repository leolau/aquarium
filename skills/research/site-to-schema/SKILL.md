---
name: site-to-schema
description: Study a website (public + logged-in) and turn its data into an approved database schema with a scheduled refresh.
version: 1.0.0
author: Leo Lau (leolau), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Web, Crawling, Login, Database, Schema, Research, Credentials]
    related_skills: [auth-web-crawler]
---

# Site to Schema

Studies a site the user may use, decides which content is **fixed** (pages,
kept as versions) and which is **variable** (tables, lists, collections,
upserted with removed rows marked), writes a `design.json` + `recipe.json`,
proposes them through the `site_db` tool, and after the user approves runs
the first load. Later refreshes are done by the backend replaying
`recipe.json` with `hermes_cli/site_recipe_runner.py` — no model involved, so
the recipe must be exact.

**Read-only on the source site, always.** Allowed: log in, navigate, open
menus, search, filter, choose dates, page through results. Never: save,
add/new/create, edit/update, delete/remove, approve/reject, upload/import,
logout, change password. The runner and `scripts/explore_site.py` refuse
such targets and abort such requests, but you must not try them in the
browser either.

## When to Use

- "Make a database of <site>", "mirror the tables of our WMS", "keep a copy
  of <portal> data and refresh it daily".
- Not for a one-off read of a few pages (use `auth-web-crawler`).

## Prerequisites

- The user is allowed to access the site and wants it copied. Ask if unsure.
- The login is saved in the credential store (see `auth-web-crawler`,
  "How the user provides credentials"): `web-login/<host>`. Never put the
  password on a command line, in a file, in chat or in memory.
- Playwright + Chromium for the scripts (`python -m playwright install
  chromium` if `explore_site.py` says no Chromium).
- The `site_db` tool (sites feature). If it is not available, stop after
  step 6 and give the user the two files.

## Files

| File | What |
|------|------|
| `scripts/explore_site.py` | log in with the stored credential and inventory pages after read-only steps: buttons (incl. `onclick`), forms + fields, tables (headers, row count, sample rows), DataTables, same-origin JSON requests, pagination, text; dangerous controls flagged `forbidden` |
| `scripts/preview_recipe.py` | dry-run `recipe.json` (no DB writes): counts, sample rows, duplicate keys, failures |
| `scripts/check_design.py` | check `design.json` + `recipe.json` shape and that they agree |
| `references/recipe-format.md` | every recipe op and option |
| `references/example-design.json`, `references/example-recipe.json` | a complete worked example |

Work in `~/site-study/<slug>/` (`design.json`, `recipe.json`,
`probes.json`, `inventory/`).

## Procedure

1. **Scope.** Restate the site, the slug (`lower_snake_case`, e.g.
   `hsdos`), what the user wants kept, and that it stays read-only. Make
   sure the login is saved; note its store name.
2. **Public pages.** `web_extract` the home/login page and any public
   pages. Note the login form (field names, submit button, the page you
   land on, an error text).
3. **Draft the login.** Write `recipe.json` with `version`, `site`,
   `base_url` and `login` (url, `username_field`, `password_field`,
   `submit`, `success` = something only visible when logged in, e.g.
   `{"selector": "a[href*=logout]"}` or `{"text": "Welcome"}`,
   `failure_text`). Prove it:
   `python scripts/explore_site.py --recipe recipe.json --credential web-login/<host> --goto /`.
   `login: FAILED` → fix selectors once; ask the user before more tries
   (accounts lock).
4. **Explore — buttons and forms, not only links.** Many sites hide data
   behind JavaScript menu buttons, search forms and date pickers; a link
   crawl finds almost nothing. Loop:
   - Run `explore_site.py` on each menu page (`--goto`) and read the
     inventory: buttons, forms, tables, pagination.
   - For each safe button / sub-menu (`forbidden: false`), add a probe that
     clicks it (`{"op": "click", "text": "SKU Table"}`), and for each
     search/report form a probe that fills a wide date range
     (`{{date-3650}}`..`{{today}}`) or leaves filters empty and submits the
     search button. Run with `--probes probes.json --out inventory/`.
   - The browser tools (`browser_snapshot`, `browser_click`) help to see
     a confusing page, but log in through the scripts so the password is
     never typed by you; if you must use the browser, follow
     `auth-web-crawler` step 4 and never click a `forbidden` control.
   - **Look for the data behind the table.** The inventory also lists
     `datatables` (tables driven by DataTables: `total` rows held by the
     page, `server_side`, `ajax_url`, column `data` keys) and
     `json_requests` (same-origin XHR/fetch JSON calls the page made:
     method, URL, query/body parameter *names*, size). Signs: "Showing 1 to
     10 of 48,015 entries", a `dataTable` class, `$(...).DataTable(...)` in
     the page script, XHR calls answering JSON, form posts with
     `draw`/`start`/`length`.
     - DataTables with `server_side: false` and a big `total` → use
       `extract_datatable` (reads every row in one go; map by the column
       `data` key with `field`, or by `header`/`index`).
     - `server_side: true`, or a search button that answers JSON → use
       `extract_json` on that endpoint (`page` block for
       `start`/`length`; date filters inside `date_windows`). Copy the
       parameter names from `json_requests`; check the endpoint only
       *reads* (search/list/report — never save/update/delete).
     - Point `table` at the table's id (the inventory's `selector`); with
       several DataTables on a page a class selector is ambiguous.
     - A source that can really be empty needs `allow_empty: true`;
       otherwise an empty result means "something broke" and the run
       does not mark rows removed.
     - Set `max_bytes` and a recipe `delay_ms`; an unpaged endpoint can
       return tens of MB and slow the site. Never page the DOM thousands
       of times.
   - Keep a list: page → how reached → what data (table headers, row
     count, paging, date filter, fields).
   Skip pure action screens (data-entry forms such as Stock In, Packing):
   they produce no data to copy. Note them in the report.
5. **Classify** every data source into an entity, with a reason:
   - **variable**: anything paginated, any table, list, search result or
     collection — even a small reference table (it gets rows added and
     removed). Needs `key` (columns that identify a row; check uniqueness
     in the preview) and typed `columns`.
   - **fixed**: a single page of content (about/help text, a settings
     summary). Stored as versions; `key` optional.
   - **Refresh** per entity: `incremental` only when there is a reliable
     date/ID filter so a search from the cursor returns every new or
     changed row (set `cursor` to that column, and `full_every`, e.g.
     `P7D`, so removals are still detected); otherwise `full`. When you
     cannot tell (e.g. the date filters on creation but rows change
     later), put the question in the entity's `question` field and **ask
     the user** before proposing.
6. **Write the recipe** (see `references/recipe-format.md`): one entity
   per design entity with the exact steps that reach the data —
   `goto`, `click` the menu button, `fill` the dates (`{{cursor}}` with a
   `default` for incremental, `{{date-N}}`/`{{today}}`), `submit` the
   search button, `paginate`, `extract_table` mapping columns by header
   text — or `extract_datatable` / `extract_json` for big DataTables and
   JSON endpoints (step 4). Write `design.json` (plan section 3.3 shape; see the example).
   Then:
   - `python scripts/check_design.py design.json recipe.json` → fix every
     problem;
   - `python scripts/preview_recipe.py --recipe recipe.json --credential web-login/<host> --sample 3`
     → every entity `ok`, counts plausible, no duplicate keys, no
     `blocked:` lines. Fix and repeat.
7. **Propose.** Call `site_db` with action `propose_design`, passing the
   design and recipe JSON objects. Tell the user, briefly: entities, kind
   + reason, key, refresh mode, row counts from the preview, anything
   skipped, and that the design waits for approval on the Sites page (or
   their "approve" in chat).
8. **Wait for approval.** Do not create tables or load data yourself.
   If the user asks for changes, edit, re-check, re-preview and propose
   again (a new version).
9. **First load.** After approval, `site_db` action `refresh` with mode
   `full`, then `run_status` until it finishes. Report per entity: rows
   inserted / updated, fixed versions, failures, and how refresh will
   continue (schedule or "Refresh now").

## Pitfalls

- A selector that worked on one page may also match a hidden template row
  or a second table; use the table's id (from the inventory) and check
  the preview count against the page's "N records" text.
- Header text changes break `extract_table` on purpose (the entity fails
  rather than writing nulls). Prefer `header` over `index`.
- Dates: give the site's display format in the column (`"format":
  "%d/%m/%Y"`) and the search fields' format in `date_format`.
- A search that caps results (e.g. 500 rows) silently truncates: split
  the date range with `date_windows`.
- Sessions time out: the runner logs in again once when a page shows the
  login form; a site that logs out on every navigation needs the user.
- Do not raise `max_pages` blindly; if the preview hits it, the paging
  stop condition is wrong.
- Never ask for the password again to "check" it, never print it, never
  put it in `recipe.json`.

## Verification

- `check_design.py` prints `ok: ready to propose`.
- `preview_recipe.py` exits 0 with every entity `ok` and plausible counts.
- `site_db` `run_status` of the first load is `ok` (or `partial` with the
  failed entities explained to the user).
