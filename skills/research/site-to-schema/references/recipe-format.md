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

| op | keys |
|---|---|
| `goto` | `url` (same site only) |
| `click` | target |
| `fill` | `selector`, `value` (template), `default` (used when `{{cursor}}` has no value), `format` |
| `select` | `selector`, `value` or `label` |
| `press` | `selector`, `key` (`Enter` or `Tab`) |
| `submit` | `selector` of the search button or form (default first form) |
| `wait` | `selector` (visible), `text`, `gone` (hidden), `ms`, `timeout_ms` |
| `extract_table` | `table` (selector), `row` (default `tbody tr`), `header` (header cell selector), `columns` |
| `extract_fields` | `key` (content key), `fields` |
| `paginate` | `steps` (run per page), `next` target **or** `page_param` (+ `start`), `max_pages`, `stop_on_empty` |
| `date_windows` | `from` (template, e.g. `{{cursor}}`), `default`, `to` (default `{{today}}`), `days`, `steps`; inside use `{{window_from}}` / `{{window_to}}` |

Column / field spec: `header` (table header text, case-insensitive) or
`selector` (inside the row / on the page) or `index`; `attr` (read an
attribute such as `href`); `type` = `text` (default), `int`, `numeric`,
`date`, `datetime`, `bool`; `format` (strptime format for dates);
fields also take `all: true` (list of every match).

Pagination stops when the next control is missing or disabled, a page has
no rows, a page repeats the previous one, or at `max_pages`.

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
