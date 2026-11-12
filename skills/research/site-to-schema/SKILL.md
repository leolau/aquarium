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
logout, change password. The runner (behind `site_db` `explore` /
`preview` and the scripts) refuses such targets and abort such requests, but you must not try them in the
browser either.

## When to Use

- "Make a database of <site>", "mirror the tables of our WMS", "keep a copy
  of <portal> data and refresh it daily".
- Not for a one-off read of a few pages (use `auth-web-crawler`).

## Prerequisites

- The user is allowed to access the site and wants it copied. Ask if unsure.
- The `site_db` tool (sites feature). It runs the logged-in study steps
  (`explore`, `preview`) on the server, where the saved login is; your
  terminal may not be able to read the credential store at all. If the
  tool is not available, see "Without the site_db tool" below.
- The site exists in `site_db` with its login saved: `site_db` action
  `list_sites` → the site's `login_saved` is `true`. Check that, not
  `list_secrets` (that lists only the person's own `secret` entries,
  never site logins). No site yet → `create_site` (site admins). Login
  not saved → `explore` falls back to the person's own saved
  `web-login/<host>` login for the same host; if it says "no saved
  login", ask the site's owner to save it on the site's page in Sites. Never ask for the password in chat, never put it on a command
  line, in a file or in memory.
- Playwright + Chromium on the server (`explore` says "browser engine not
  installed" otherwise: stop and tell the user).

## Files

| File | What |
|------|------|
| `site_db` `explore` | log in with the site's saved login and inventory pages after read-only steps: buttons (incl. `onclick`), forms + fields, tables (headers, row count, sample rows), DataTables, same-origin JSON requests, the XHR/fetch calls each step triggered (`step_requests`), pagination, text; dangerous controls flagged `forbidden` |
| `site_db` `preview` | dry-run a recipe (no DB writes, `max_rows` per entity, default 50): counts, sample rows, duplicate keys, failures |
| `scripts/explore_site.py`, `scripts/preview_recipe.py` | the same two from a shell, for development boxes where the terminal can read the credential store; on a hardened box they stop with "use site_db explore / preview" |
| `scripts/check_design.py` | check `design.json` + `recipe.json` shape and that they agree |
| `references/recipe-format.md` | every recipe op and option |
| `references/example-design.json`, `references/example-recipe.json` | a complete worked example |

Work in `~/site-study/<slug>/` (`design.json`, `recipe.json`,
`probes.json`, `inventory/`).

## Procedure

1. **Scope.** Restate the site, the slug (`lower_snake_case`, e.g.
   `hsdos`), what the user wants kept, and that it stays read-only. Make
   sure the site is in `site_db list_sites` with `login_saved: true`.
2. **Public pages.** `web_extract` the home/login page and any public
   pages. Note the login form (field names, submit button, the page you
   land on, an error text).
3. **Draft the login.** Write `recipe.json` with `version`, `site`,
   `base_url` and `login` (url, `username_field`, `password_field`,
   `submit`, `success` = something only visible when logged in, e.g.
   `{"selector": "a[href*=logout]"}` or `{"text": "Welcome"}`,
   `failure_text`). Prove it: `site_db` action `explore`, `site` = the
   slug, `recipe` = the draft, `goto` = `["/"]`. `login failed` → fix
   selectors once; ask the user before more tries (accounts lock).
4. **Explore — buttons and forms, not only links.** Many sites hide data
   behind JavaScript menu buttons, search forms and date pickers; a link
   crawl finds almost nothing. Loop:
   - `explore` each menu page (`goto`, a few per call) and read the
     inventory: `summary`, then buttons, forms, tables, pagination.
   - For each safe button / sub-menu (`forbidden: false`), add a probe that
     clicks it (`{"op": "click", "text": "SKU Table"}`), and for each
     search/report form a probe that sets the narrowest filter (below)
     and submits the search button. Pass them as `probes`
     (`[{"name": ..., "steps": [...]}]`, up to 20 per call) and keep
     what you learn in `probes.json` / `inventory/`.
   - **Narrow filter first, every time.** Before clicking any
     Search/Query/Filter button, set the narrowest filter the form has:
     one day (`{{date-1}}`..`{{date-1}}`), or a single known value (one
     warehouse, one ID seen on another page). **Never click with empty
     filters**: on many sites that returns the whole database and slows
     the site for everyone. If no filter can be set, do not click; put a
     question in your notes instead. The inventory's `warnings` list
     every click/submit made with empty date/filter inputs.
   - **Cut-off calls.** Explore cuts off any XHR/fetch answer a step sets
     off past 2 MB (recipe `explore_max_call_bytes`, 10 kB to 50 MB) and
     lists it in `step_requests` as `aborted: "too_large"` with
     `bytes_seen` (and `content_length` when announced). That means the
     filter was too wide: narrow it; do not repeat the wide search or
     raise the cap to get it through.
   - **Probe budget.** If the site slows down (a step times out, or
     answers take more than 10 s), stop probing. Wait a few minutes
     before the next `explore` call, and send fewer, narrower probes per
     call after that.
   - **Configuration / setup screens** (Set Function, Set WorkFlow,
     settings, parameters) often hold read-only lookup lists (function or
     workflow definitions, reason codes) as a table or JSON. Open them
     and check for such a table before excluding the page as "config";
     only the edit forms are out of scope, and an Edit/Save button next
     to a list does not make the list itself off limits.
   - The browser tools (`browser_snapshot`, `browser_click`) help to see
     a confusing page, but log in through `explore` so the password is
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
     - **A table that stays empty until you search** (a query builder,
       a "Search"/"Query" button, a report wizard) is filled by an
       XHR/fetch the button fires, so nothing shows on page load. Probe
       it: `goto` the page, `fill` a *narrow* date filter (one or two
       days, e.g. `{{date-1}}`..`{{today}}`), `click` the search button,
       then `wait` for a result row. The page's `step_requests` lists,
       per step, the same-origin calls that step triggered: method,
       path, request content type, a masked body sample, status, size
       and, for JSON, its `shape` (`keys`, the guessed `records_path`,
       `records` count, first `record_keys`). Turn that call into an
       `extract_json` step: same `url`/`method`, `form` or `json` body
       with the same fields, the date fields set to
       `{{window_from}}`/`{{window_to}}` inside a `date_windows` (small
       `days`, so each call is bounded; calls run one at a time with
       `delay_ms` between them), `records` = `records_path`, columns by
       `field` from `record_keys`. Leave out tokens the sample shows as
       masked unless the endpoint refuses without them.
     - A click that **times out** (a heavy page, a huge dropdown) still
       returns `step_requests` captured so far and a `hint`; read the
       endpoint there instead of retrying the click. Give a slow step a
       `timeout_ms` (clicks/submits default to twice the recipe's
       `timeout_ms`), or pick a more specific selector.
     - Point `table` at the table's id (the inventory's `selector`); with
       several DataTables on a page a class selector is ambiguous.
     - A source that can really be empty needs `allow_empty: true`;
       otherwise an empty result means "something broke" and the run
       does not mark rows removed.
     - Set `max_bytes` and a recipe `delay_ms`; an unpaged endpoint can
       return tens of MB and slow the site. Never page the DOM thousands
       of times.
   - **Secrets sent to the browser.** If a table or JSON answer holds
     password, hash, token or API-key fields (the inventory's `security`
     note and `secret_columns` / `secret_keys` flag them), exclude the
     **whole entity**, not just the column: add the page to
     `design.exclusions` as `{"page": ..., "reason": ..., "security":
     true}` and tell the user it is a security issue to report to the
     site owner. Never store those columns, and never copy their values
     into notes, files or chat.
   - Keep a list: page → how reached → what data (table headers, row
     count, paging, date filter, fields).
   Skip pure action screens (data-entry forms such as Stock In, Packing):
   they produce no data to copy. List every skipped page in
   `design.exclusions` (`page`, `reason`) and in the report.
5. **Classify** every data source into an entity, with a reason:
   - **variable**: anything paginated, any table, list, search result or
     collection — even a small reference table (it gets rows added and
     removed). Needs `key` (columns that identify a row; check uniqueness
     in the preview) and typed `columns`.
   - **fixed**: a single page of content (about/help text, a settings
     summary). Stored as versions; `key` optional.
   - **Very large tables** (an estimated >~100k rows, or a search that
     needs a date filter) that offer a date/activity filter: propose
     `incremental` with a 1-day `date_windows` from the cursor plus
     `full_every` (e.g. `P30D`), not a nightly full read. A nightly
     `full` is only for tables read cheaply in one page load.
   - **Refresh** per entity: `incremental` only when there is a reliable
     date/ID filter so a search from the cursor returns every new or
     changed row (set `cursor` to that column, and `full_every`, e.g.
     `P7D`, so removals are still detected); otherwise `full`. When you
     cannot tell (e.g. the date filters on creation but rows change
     later), use the safe choice (`full`, or `incremental` with a
     `full_every` re-check) and put the question in the entity's
     `question` field. Ask the user before proposing only when the
     shortcut would cut a lot of load on the site.
6. **Write the recipe** (see `references/recipe-format.md`): one entity
   per design entity with the exact steps that reach the data —
   `goto`, `click` the menu button, `fill` the dates (`{{cursor}}` with a
   `default` for incremental, `{{date-N}}`/`{{today}}`), `submit` the
   search button, `paginate`, `extract_table` mapping columns by header
   text — or `extract_datatable` / `extract_json` for big DataTables and
   JSON endpoints (step 4). Write `design.json` (plan section 3.3 shape; see the example).
   - Set the design's `timezone` to the IANA zone the site shows its
     times in (e.g. `"Asia/Hong_Kong"`), judged from the site: its
     region, a zone label, or times you can match to "now". Timestamps
     without an offset are stored as wall-clock time in that zone;
     values that carry an offset (`Z`, `+08:00`) keep it. Omit it only
     for a site that shows UTC (the default).
   Then:
   - `python scripts/check_design.py design.json recipe.json` → fix every
     problem;
   - `site_db` action `preview` (`site`, `recipe`, optional `entities`,
     `mode`, `max_rows`) → every entity `ok`, counts plausible, no
     `duplicate_keys`, no `blocked_requests`. `capped: true` only means
     the preview stopped at `max_rows`. Fix and repeat.
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

## Without the site_db tool

Only on a development box where your terminal can read the credential
store (`web-login/<host>`, see `auth-web-crawler`):
`python scripts/explore_site.py --recipe recipe.json --credential web-login/<host> --goto / [--probes probes.json --out inventory/]`
and `python scripts/preview_recipe.py --recipe recipe.json --credential web-login/<host> --sample 3`.
Stop after step 6 and give the user the two files. If a script says the
credential store is not reachable, that is the hardened setup: use
`site_db`, or stop and report (below).

## Stop and report

- **Study from scratch.** Do not reuse a design, recipe or probe files
  from an earlier study unless the user points you to them.
- **When a prerequisite fails, stop and tell the user** what is missing
  and what they can do: the login can't be read from the credential
  store, the `site_db` tool refuses, Playwright/Chromium is missing, or
  the work folder isn't writable. Do not work around it: no `sudo`, no
  reading environment variables, other people's secrets, database
  settings or other services' files, no hunting for credentials on the
  host.

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
- `site_db` `preview` returns `ok: true` with every entity `ok` and plausible counts.
- `site_db` `run_status` of the first load is `ok` (or `partial` with the
  failed entities explained to the user).
