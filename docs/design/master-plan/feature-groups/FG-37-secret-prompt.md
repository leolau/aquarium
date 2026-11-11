# FG-37 — Secret prompt (masked popup + one-time secure links)

Passwords, PATs and API keys must never travel as chat text. When the agent
needs a secret, or a person wants to give one, a masked popup collects it and
sends it over HTTPS straight to the per-user credential store. The agent only
ever gets the secret's **name**; tools take the value by name at use time.

## Requirement (from Yan)

> "Right now, if the user wants to pass in secrets such as login password or
> PAT, it is not safe to pass it over the chat in plain text. I need to build
> in a feature, (may be via internal MCP?), so that when agent ask users for
> secrets or user volunteers to provide secrets, a popup window is opened
> allowing user to enter the secrets (paste) while showing "*" and send it
> over to the backend in HTTPS so that it is 100% safe."

Decisions (Yan, 2026-11-11):

- Channels: **agent-home chat, plus a one-time secure link when the agent asks
  over WhatsApp, Telegram or email.**
- A built-in tool, not an internal MCP server: the approval pause/resume
  plumbing already exists; an MCP hop adds no safety.

What "safe" means here: the value never enters chat history, the model's
context, the model provider, logs, SSE streams or the request registry. The
backend still decrypts/reads it to use it (credential store trust model,
`docs/design/unified-credential-store.md` §4.1).

## Contract (shared by W1–W4 — do not change without updating this doc)

### Credential kind `secret` (`hermes_cli/credential_store.py`)

`KindSpec(name="secret", required=("value",), optional=("username", "note"),
secret_fields=("value",))`. Username+password requests use the existing
`password` kind. Provider for both is **`secret`**; `name` is a slug
(`^[a-z0-9][a-z0-9._-]{0,63}$`) chosen by the agent or the person.
Volunteered and requested secrets live in the same place, owned by the
person (C2 `owner_user_id`, visibility `private`).

### Request registry (`hermes_cli/secret_requests.py`, W1)

Cross-process (gateway, dashboard and agent-home BFF are separate
processes): SQLite `secret_requests.db` in the profile's `HERMES_HOME`, via
`sqlite_util.write_txn()`.

```
secret_requests(id TEXT PK,            -- "sr_" + 16 hex, safe to show
                token_hash TEXT UNIQUE, -- sha256 of the one-time link token; NULL for chat requests
                owner_user_id TEXT, profile TEXT, session_key TEXT, run_id TEXT,
                name TEXT, label TEXT, purpose TEXT, kind TEXT,   -- secret|password
                username TEXT,           -- prefill for kind=password, optional
                channel TEXT,            -- agent-home|whatsapp|telegram|email|...
                status TEXT,             -- pending|stored|declined|expired
                created_at REAL, expires_at REAL, resolved_at REAL)
```

**No secret value is ever written to this table.**

Python API (module functions):

- `open_request(*, owner_user_id, profile, session_key, run_id, name, label,
  purpose, kind, username=None, channel, ttl_seconds=900, with_link=False)
  -> (SecretRequest, token|None)` — `token` = `secrets.token_urlsafe(32)`,
  only its sha256 is stored; returned once, for the link.
- `get_request(request_id)`, `get_by_token(token)` (pending + unexpired only).
- `fulfil(request_id, *, principal, values) -> SecretRequest` — validates the
  principal is the owner, writes the credential (`provider="secret"`,
  `name`, `kind`, `payload=values`) through `default_credential_store()`,
  sets `status=stored`, clears `token_hash`. Single use: a second call fails.
- `fulfil_by_token(token, *, values)` — same, owner taken from the row.
- `decline(request_id | token)`.
- `wait(request_id, timeout) -> status` — polls the row (0.5 s), marks
  `expired` on timeout.

### Agent tools (W1 + W2)

- `request_secret(name, label, purpose, kind="secret", username=None)` (W1,
  `tools/secret_request_tool.py`). Opens a request and blocks the turn
  (default 10 min) until stored/declined/expired. Returns
  `{"status": "stored", "secret": name, "kind": kind}` or
  `{"status": "declined" | "expired"}` — **never the value**.
  - agent-home chat turn (api_server streamed run): emits SSE
    `secret.request` (below) through a notify surface wired like
    `_approval_notify` in `gateway/platforms/api_server.py`.
  - messaging turn (WhatsApp/Telegram/email via `gateway/run.py`): W4 sends
    the one-time link through the adapter.
  - no surface: returns `{"status": "unavailable", "hint": "..."}` and tells
    the model to ask the person to add it in Settings → Connected accounts.
- `list_secrets()` (W2): names, kinds, usernames, `updated_at` of the
  caller's `secret`-provider entries. No values.
- Terminal `secret_env` (W2): optional `{"ENV_VAR": "secret-name"}` (or
  `"secret-name.username"` / `.password` / `.value`) on the terminal tool.
  Values are resolved for the session principal via `resolve_for_service`,
  injected into **that one command's** environment only, and every exact
  occurrence is masked (`***`) in the returned output and in logs.
- System-prompt guidance (W2): never ask for secrets as chat text; use
  `request_secret`; refer to secrets by name.

### SSE event (agent-home chat, W1 emits, W3 renders)

```json
{"event": "secret.request", "request_id": "sr_…", "message_id": "…",
 "name": "github-pat", "label": "GitHub personal access token",
 "purpose": "Push the fix to leolau/aquarium", "kind": "secret",
 "username": null, "expires_at": 1794380000.0}
```

Run status becomes `waiting_for_secret` while pending.

### HTTP

| Route | Who | Body | Effect |
|---|---|---|---|
| `POST /api/secret-requests/{id}` (Python, `hermes_cli/secret_requests_api.py`, W1) | signed-in owner | `{"values": {"value": "…"}}` or `{"values": {"username","password"}}` or `{"decline": true}` | `fulfil` / `decline`; 404 unknown, 403 not owner, 409 not pending |
| `POST /api/chat/secret` (agent-home BFF, W3) | signed-in | `{request_id, values?, decline?}` | forwards to the above |
| `GET /api/secret-links/{token}` (Python, W4) | **no login**, token | — | `{label, purpose, kind, username, expires_at}`; 404 if used/expired |
| `POST /api/secret-links/{token}` (Python, W4) | **no login**, token | same as above | `fulfil_by_token` / decline |
| `/secret/[token]` page + `GET/POST /api/secret-links/[token]` BFF (agent-home, W4) | public | — | masked form for messaging links |

Responses never echo values. Values are never logged (add the routes to
the request-logging redaction). `Cache-Control: no-store` on all of them.
Link token routes are rate-limited per IP and answer 404 for every
not-pending case (no oracle).

Link URL: `{agent_home.public_url}/secret/{token}`; `agent_home.public_url`
is a new config key (no default domain in the public repo; production sets
it in its own config). If unset, the tool returns `unavailable`.

## Work items

| W | Scope | Owner files (others: touch only if needed) |
|---|---|---|
| W1 | Kind `secret`; `secret_requests.py`; `request_secret` tool + registry entry; api_server `secret.request` surface + `waiting_for_secret`; `POST /api/secret-requests/{id}`; tests | `hermes_cli/credential_store.py`, `hermes_cli/secret_requests*.py`, `tools/secret_request_tool.py`, `gateway/platforms/api_server.py`, `hermes_cli/web_server.py` |
| W2 | `list_secrets`; terminal `secret_env` injection + output masking; system-prompt guidance; tests | `tools/terminal_tool.py`, `tools/secret_list_tool.py`, `agent/prompt_builder.py` (or wherever tool guidance lives) |
| W3 | agent-home: `secret.request` in stream types + `SecretRequestModal` (masked `type=password`, paste, show/hide, decline, expiry); `/api/chat/secret` BFF; composer lock button (volunteer → `PUT /api/credentials/secret/{name}` kind `secret`, then inserts `[secret: name]`); paste detection warning (secret-looking text in the normal box); route-roles, i18n en + zh-Hant, tests | `agent-home/src/components/chat/**`, `agent-home/src/lib/chat/**`, `agent-home/src/app/api/chat/secret/` |
| W4 | Messaging: `request_secret` on a messaging turn sends the one-time link via the adapter and waits; `agent_home.public_url`; public `GET/POST /api/secret-links/{token}` + rate limit; agent-home public `/secret/[token]` page (+ `loading.tsx`, smoke spec, middleware/public-route allowance), BFF; tests | `gateway/run.py`, `hermes_cli/secret_links_api.py`, `agent-home/src/app/secret/`, `agent-home/src/app/api/secret-links/` |
| W5 | Cross-review: combine W1–W4, end-to-end tests (chat request → modal → stored → `secret_env` command; link flow), docs (user guide + this checklist), fix integration gaps | — |

W1–W4 build in parallel against this contract; W5 runs after they merge.

## Checklist

- [ ] W1 backend core
- [ ] W2 secret use in tools
- [ ] W3 agent-home popup + volunteer
- [ ] W4 one-time links for messaging
- [ ] W5 cross-review + docs
