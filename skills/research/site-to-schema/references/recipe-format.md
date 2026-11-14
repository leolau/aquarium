# recipe.json format (version 1)

Executed by `hermes_cli/site_recipe_runner.py` (`run_recipe`). Plan:
`docs/plans/2026-11-10-001-site-to-schema-plan.md` section 3.4.

```json
{"version": 1, "site": "<slug>", "base_url": "https://host/",
 "date_format": "%Y-%m-%d", "timeout_ms": 30000, "delay_ms": 0,
 "login": {...}, "entities": {"<name>": {...}}}
```

- `date_format`: how `{{today}}` / `{{date-N}}` / `{{cursor}}` render into
  form fields (per step `format` overrides; per entity `date_format` too).
- `delay_ms`: pause after each page load (be gentle with small servers).
- `explore_max_call_bytes` (explore only, default 2000000, 10000 to
  50000000): an XHR/fetch answer a step sets off is cut off past this
  size, whether or not the page reads it, and reported in `step_requests`
  as `aborted: "too_large"`. A synchronous XHR is refused
  (`aborted: "sync_xhr"`). Refresh runs ignore it (`extract_json` has its
  own `max_bytes`).
- `allow_empty_filters` (explore only, `click`/`submit`, true/false):
  explore does not click/submit a search whose filters are all empty and
  reports `refused: "empty_filters"` with the empty fields; `true` lets
  that one step through. Refresh runs ignore it.

## login

| key | meaning |
|---|---|
| `url` | login page (relative to `base_url`) |
| `username_field` / `password_field` | CSS selectors (defaults `input[name=username]` / `input[type=password]`) |
| `next` | selector/target of a "Next" button for identifier-first logins |
| `submit` | selector or `{"text": ...}`; omitted = press Enter |
| `success` | `{"selector"}` / `{"text"}` / `{"url_contains"}` / `{"url_not_contains"}`; omitted = password field gone |
| `failure_text` | text the site shows on a bad login |

If a later page shows the login form again, the runner logs in again once
and retries that page.

## entity

| key | meaning |
|---|---|
| `kind` | `variable` or `fixed` (must match the design) |
| `key` | list of column names identifying a row (required for variable) |
| `cursor` | column whose max value becomes the next incremental cursor |
| `mode` | `full` = never use a cursor for this entity |
| `removal_safe` | `false` = never report it in `full_entities` (no removal marking) |
| `steps` | list of steps below |

## steps

Targets are `{"selector": "css"}` or `{"text": "Visible label"}` (button,
link or input button; `exact`, `nth` optional).

`timeout_ms` (100 to 600000) on a `click`, `submit`, `press`, `wait`,
`extract_datatable` or `extract_json` step overrides the recipe's for that
step. Without one, `click`, `submit` and `press` wait twice the recipe's
`timeout_ms`, since a click on a heavy page can take a while.

| op | keys |
|---|---|
| `goto` | `url` (same site only) |
| `click` | target, `timeout_ms`, `allow_empty_filters` |
| `fill` | `selector`, `value` (template), `default` (used when `{{cursor}}` has no value), `format` |
| `select` | `selector`, `value` or `label` |
| `press` | `selector`, `key` (`Enter` or `Tab`), `timeout_ms` |
| `submit` | `selector` of the search button or form (default first form), `timeout_ms`, `allow_empty_filters` |
| `wait` | `selector` (visible), `text`, `gone` (hidden), `ms`, `timeout_ms` |
| `extract_table` | `table` (selector), `row` (default `tbody tr`), `header` (header cell selector), `columns` |
| `extract_fields` | `key` (content key), `fields` |
| `extract_datatable` | `table` (selector of a client-side DataTables `<table>`), `columns`, `timeout_ms`, `optional`, `allow_empty` |
| `extract_json` | `url` (same site), `method` (`GET`/`POST`), `params` (query), `form` **or** `json` (body; POST only), `headers`, `records` (dotted path; `""` = top-level array), `columns`, `page`, `max_bytes` (default 10 MB), `delay_ms`, `default`, `format`, `timeout_ms`, `allow_empty` |
| `paginate` | `steps` (run per page), `next` target **or** `page_param` (+ `start`), `max_pages`, `stop_on_empty` |
| `date_windows` | `from` (template, e.g. `{{cursor}}`), `default`, `to` (default `{{today}}`), `days`, `steps`, `split_min_minutes`, `time_format`; inside use `{{window_from}}` / `{{window_to}}` (dates) or `{{window_start}}` / `{{window_end}}` (timestamps, default `%Y-%m-%d %H:%M:%S`, end inclusive: `... 23:59:59`) |

Column / field spec: `header` (table header text, case-insensitive) or
`selector` (inside the row / on the page) or `index`; `attr` (read an
attribute such as `href`); `type` = `text` (default), `int`, `numeric`,
`date`, `datetime`, `bool`; `format` (strptime format for dates);
fields also take `all: true` (list of every match).

Pagination stops when the next control is missing or disabled, a page has
no rows, a page repeats the previous one, or at `max_pages`.

**`when`** (any step, also inside `paginate` / `date_windows`):
`"full"` runs the step only on a full load of the entity, `"incremental"`
only on an incremental one; without `when` it always runs. A load is full
when the entity has no cursor (`mode: full` run, entity `mode: full`, or no
cursor saved yet) and incremental otherwise. A step that only runs
incrementally (or sits inside one) needs no `default` for `{{cursor}}`.
Use it to read a big table by its fast indexed date on full loads, and
on incremental loads to add slower filters (e.g. activity/update dates)
for the last day so changed rows are caught:

```json
"steps": [
  {"op": "date_windows", "when": "full", "from": "{{date-3650}}", "days": 90,
   "steps": [{"op": "extract_json", "url": "/search/stock", "method": "POST",
              "form": {"stock_in_from": "{{window_from}}", "stock_in_to": "{{window_to}}"},
              "columns": {"imei": {"field": "imei"}}}]},
  {"op": "date_windows", "when": "incremental", "from": "{{cursor-1}}", "days": 1,
   "steps": [{"op": "extract_json", "url": "/search/stock", "method": "POST",
              "form": {"updated_from": "{{window_from}}", "updated_to": "{{window_to}}"},
              "columns": {"imei": {"field": "imei"}}}]}
]
```

Skipped steps do not count as empty extractions; the entity is a full
load only when every extraction step that ran produced records.

**Empty extractions are not full loads.** If any `extract_*` step of an
entity produced no record in a run (summed over all its pages and date
windows), the entity is not reported as a full load, so no existing rows
are marked removed, and the run gets a warning. Set `"allow_empty": true`
on a step whose source can legitimately be empty.

### Big tables: `extract_datatable` and `extract_json`

Admin apps often keep thousands of rows in the browser and show ten at a
time. Paging the DOM that way is slow and hammers the site; read the data
directly instead (both ops are read-only).

`extract_datatable` reads **every** row of a client-side DataTables table
through the page's own DataTables API (`jQuery.fn.dataTable` or the 2.x
`window.DataTable` global: `rows({search: "none"}).data()`, so a filter
typed on screen does not hide rows). It waits until the table finished
loading. Columns: `field` (dotted key of the row object, e.g.
`model.name`; for array rows use `index`), `index` (column number) or
`header` (column title); `attr` reads an attribute out of an HTML cell (e.g.
`href`), and HTML cells are otherwise reduced to their text (`html: false`
keeps the raw value). It fails clearly when the page has no DataTables
library, the table is not a DataTable (use `extract_table` + `paginate`), or
it is **server-side** (`serverSide: true`: the page only holds the visible
rows) — the error names the table's endpoint so you can switch to
`extract_json`. With `scrollX`/`scrollY` DataTables clones the header (and
footer) into separate tables; every match is resolved to its instance's real
table, so `table.dataTable` works, but a selector matching two different
DataTables fails as an *ambiguous selector* — use the table's id.

```json
{"op": "extract_datatable", "table": "#device_table",
 "columns": {"imei": {"field": "imei"}, "model": {"header": "Model"},
             "grade": {"index": 3, "type": "text"}}}
```

`extract_json` calls a same-origin JSON read endpoint from the logged-in
page (a `fetch` with the session cookies and `X-Requested-With:
XMLHttpRequest`; redirects are not followed). The URL must stay on the site
and pass the forbidden-word check, as do the request values; templates
(`{{cursor}}`, `{{window_from}}`, `{{window_to}}`, `{{date-N}}`) work in
`params`, `form` and `json` values, so it can sit inside `date_windows`.
`records` is the dotted path of the row list in the answer (`""` for a
top-level array, `data` for DataTables); columns are `field` (dotted path
inside one record) or `index` (array records). A session that expired
(login page or redirect instead of JSON) is logged in again once.

`page` pages a start/length endpoint (DataTables server-side): `start_param`,
`length_param`, `length`, optional `start` (default 0), `draw_param` (sent
as 1, 2, …), `total` (path of the total count, e.g. `recordsFiltered`),
`max_pages`, `in` (`form`/`json`/`params`; default: where the body is).
Paging stops when a page returns fewer than `length` records, the total is
reached, a page repeats the previous one, or at `max_pages`.

Fragile sources: every answer is cut off at `max_bytes` (default 10 MB) and
the step fails with a hint to add `page` or narrower `date_windows`; the
recipe's `delay_ms` (or the step's own `delay_ms`) is waited after every
call. Keep `length` modest (100–1000) and prefer `date_windows` over one
huge request.

Busy days: when an endpoint has no paging and some windows still answer
more than `max_bytes`, give the `date_windows` a `split_min_minutes` (e.g.
`60`) and filter by `{{window_start}}` / `{{window_end}}`. A window whose
answer is too large is halved and retried, down to that many minutes, so
only the busy days cost extra requests; a window still too large at the
minimum fails the entity as before. Do not just raise `max_bytes`.

```json
{"op": "extract_json", "url": "/search/rma_case", "method": "POST",
 "form": {"date_from": "{{window_from}}", "date_to": "{{window_to}}"},
 "records": "", "max_bytes": 5000000,
 "columns": {"case_no": {"field": "case_no"},
             "customer": {"field": "customer.name"},
             "opened": {"field": "opened", "type": "date"}}}

{"op": "extract_json", "url": "/api/rma_cases", "method": "POST",
 "form": {"search[value]": ""}, "records": "data",
 "page": {"start_param": "start", "length_param": "length", "length": 500,
          "draw_param": "draw", "total": "recordsFiltered"},
 "columns": {"case_no": {"field": "case_no"}}}
```

## Templates

`{{today}}`, `{{date-N}}` / `{{today+N}}` (days), `{{cursor}}`,
`{{cursor-N}}` (date cursors), `{{window_from}}`, `{{window_to}}`.

## Refused

Any target, URL or element whose text/id/class/name/href/onclick/form
action says save, add, new, create, insert, edit, modify, update, delete, remove,
destroy, drop, approve, reject, void, cancel, upload, import, reset, purge,
logout/sign out, change password — statically (the recipe is rejected) and
at run time (the element is inspected before the click; requests to such
URLs are aborted). Leaving `base_url`'s origin is refused.
