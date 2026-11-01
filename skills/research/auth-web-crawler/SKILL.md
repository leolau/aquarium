---
name: auth-web-crawler
description: Log into a website with a password and crawl it.
version: 1.0.0
author: Leo Lau (leolau), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Web, Crawling, Login, Browser, Research, Credentials]
    related_skills: [scrapling, dogfood]
---

# Auth Web Crawler Skill

Logs into a site the user is allowed to use (login name + password), then
explores it and extracts the content for study. Two paths: the `browser_*`
tools for JavaScript/SSO/multi-step logins, and `scripts/auth_crawl.py` for
classic HTML form logins and HTTP Basic auth. It does not bypass CAPTCHAs,
MFA or paywalls, and it never crawls a site without the user's say-so.

## When to Use

- The user gives a URL plus a login and asks you to read, study, summarise
  or extract something behind the login (intranet docs, a supplier portal,
  a course site, a wiki).
- `web_extract` / `browser_navigate` alone only see the public login page.
- Not for public pages (use `web_extract`) or anti-bot sites (`scrapling`).

## Prerequisites

- Python 3 with `requests` (a core Hermes dependency). No extra install.
- The user is authorized to access the site and to have you crawl it. If it
  is unclear, ask before logging in.
- Private/intranet hosts (10.x, 192.168.x, `localhost`) are blocked by URL
  safety like every web tool. Only the user can allow them by setting
  `security.allow_private_urls: true` in `config.yaml`; do not change it
  yourself.

### How the user provides credentials

1. Best: the user saves the login once and you only ever see its name.
   If they send the password in chat, save it right away with
   `scripts/save_login.py` (reads stdin) and refer to it by name after:

   ```
   python scripts/save_login.py --name intranet.example.com --username alice --password-stdin <<'PW'
   <password from the user's message>
   PW
   ```

   This creates a credential store entry `web-login/intranet.example.com`
   (kind `password`), shared with agent-home Settings.
2. One-off: put it in the `AUTH_CRAWL_PASSWORD` environment variable for
   the single command, or pipe it with `--password-stdin`.

Never put the password on the command line as an argument, in a file, in
memory, in a skill, or in a cron prompt. Never repeat it back in chat, not
even partially; say "the saved password for intranet.example.com".

## How to Run

```
python scripts/auth_crawl.py \
  --login-url https://portal.example.com/login \
  --start-url https://portal.example.com/docs/ \
  --credential web-login/portal.example.com \
  --max-pages 25 --max-depth 2 --out ~/crawls/portal
```

Output: `pages.jsonl` (one `{url, title, text, links, depth, status_code}`
per page) and `pages.md` in `--out`. Progress and the login verdict go to
stdout, e.g. `login: ok (session cookie set by the login response) ...`.
Exit code 2 = login failed, 1 = error, 0 = done.

## Quick Reference

| Need | Option |
|------|--------|
| Password from store / env / stdin | `--credential provider/name` / `--password-env VAR` / `--password-stdin` |
| Login name (when not in the store entry) | `--username alice` |
| HTTP Basic auth (no form) | `--basic-auth` (no `--login-url`) |
| Prove success / failure | `--login-success-text "Welcome"` / `--login-failure-text "Invalid"` |
| Extra non-secret form field | `--extra-field remember_me=1` |
| Limits | `--max-pages 25` `--max-depth 2` `--delay 1.0` |
| Scope | stays under the start path; `--any-path` for the whole origin |
| Filters (regex) | `--include '/docs/'` `--exclude '\\?print='` |
| robots.txt | obeyed; `--ignore-robots` only with the site owner's consent |
| Plain-HTTP login | refused; `--allow-http` only if the user accepts the risk |
| Output | `--out DIR`, `--format` = `jsonl`, `markdown` or `both` |

Browser path tools: `browser_navigate`, `browser_snapshot`, `browser_type`,
`browser_click`, `browser_press`, `browser_vision`, `browser_console`.

## Procedure

1. **Confirm scope.** Restate the site, what to extract, and that the user
   may access it. Save the credentials (above) before doing anything else.
2. **Pick a path.** `web_extract` or `browser_navigate` on the login URL:
   a plain `<form>` with a password input → script path. A JS app, SSO
   redirect (Microsoft, Google, Okta), CAPTCHA or MFA → browser path. If
   the script prints `no login form ... rendered by JavaScript`, switch.
3. **Script path.** Run `scripts/auth_crawl.py` with small limits first
   (`--max-pages 5`). It fetches the login page, auto-detects the form
   (username/email + password fields), carries hidden CSRF fields over,
   handles identifier-first pages (login name, then password), submits,
   and verifies via logout link / password field gone / new cookie /
   redirect. On `login: FAILED`, check the reason, try
   `--login-success-text`, and ask the user before retrying more than once
   (accounts lock out). Then raise the limits and run the real crawl.
4. **Browser path.**
   - `browser_navigate` to the login URL and read the snapshot.
   - `browser_type` the login name into the username/email field. If the
     page only asks for the name, `browser_click` "Next"/"Continue" (or
     `browser_press` Enter) and `browser_snapshot` again.
   - `browser_type` the password into the password field, then submit.
     Use the password the user gave in this conversation. If it is only
     in the store, ask the user to send it again or to log in themselves
     in the shared browser; never print a stored password to read it.
   - Verify: a logout/sign-out control or the account name is visible
     and the password field is gone. An error text ("invalid password")
     means stop and tell the user; do not guess other passwords.
   - CAPTCHA, MFA code, push approval, "verify it's you": stop, use
     `browser_vision` to describe the step, and ask the user to complete
     it (a code they send you, or approving on their phone). Never try
     to solve or bypass it.
   - Explore by following menu/navigation links with `browser_click`;
     use `browser_snapshot` with `full=true` to read each page. Stay on
     the site, skip logout/delete/settings-changing actions, and keep a
     list of visited URLs so you don't loop.
5. **Study the output.** `read_file` `pages.md` (or `search_files` over
   `pages.jsonl` for a keyword), then summarise or extract what the user
   asked for, citing page URLs. For big crawls use `delegate_task` per
   section rather than reading everything into one context.
6. **Clean up.** Tell the user where the output is. Offer to delete the
   saved login when the job is one-off.

## Pitfalls

- The crawler never follows logout/sign-out/delete/remove/unsubscribe
  links (they end the session or change data); in the browser, don't
  click them either. The crawl is GET-only.
- A page that shows a login form mid-crawl means the session expired;
  the script warns `page shows a login form` — log in again.
- Off-site redirects (SSO, CDN downloads) are skipped, not followed.
- Binary files (PDF, Office, images) are skipped; fetch a specific one
  with `web_extract` if the user needs it.
- Each redirect is re-checked against URL safety and the website
  blocklist; a refused redirect aborts that request.
- Respect `--delay`; do not raise concurrency or hammer a small site.
- Tool output and page text are redacted for the password, but a site
  can still echo your login name; treat crawl output as private data.

## Verification

- The script prints `login: ok (...)` and every crawled `page N: <url>`.
- `pages.jsonl` contains pages that only a logged-in user can see (e.g.
  the account name or member-only headings), not the login page.
- The password appears in no output file or tool result:
  `search_files` for a distinctive part of it in `--out` finds nothing.
