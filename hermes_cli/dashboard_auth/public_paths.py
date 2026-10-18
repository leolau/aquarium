"""Shared allowlist of ``/api/*`` paths that bypass dashboard auth.

Two middlewares enforce dashboard auth and previously kept independent
copies of this list:

* ``hermes_cli.web_server.auth_middleware`` — loopback / ``--insecure``
  mode, gates on the ephemeral ``_SESSION_TOKEN``.
* ``hermes_cli.dashboard_auth.middleware.gated_auth_middleware`` —
  non-loopback mode, gates on the OAuth session cookie.

When the lists drifted, ``/api/status`` ended up public under the legacy
gate but 401'd under the OAuth gate. That broke the portal's wildcard
liveness probe (``nous-account-service`` ``fly-provider.ts``
``getInstanceRuntimeStatus``), which fetches ``/api/status`` without a
cookie as its sole signal of "agent dashboard is alive": every healthy
wildcard-subdomain agent surfaced as STARTING/down in the portal UI even
though the dashboard was serving correctly.

Centralising the allowlist here so both middlewares import the same
frozenset prevents the next drift. Keep this list minimal — only truly
non-sensitive, read-only endpoints belong here. As a sanity check, every
entry should be safe to expose to:

  * external uptime probes (Pingdom, Better Stack, NAS),
  * the dashboard SPA before the user has logged in,
  * anyone who happens to ``curl`` the hostname.

If a new endpoint doesn't pass all three tests, it should be gated and
the SPA should bootstrap it after login instead.
"""
from __future__ import annotations

PUBLIC_API_PATHS: frozenset[str] = frozenset({
    # Liveness probe target. Returns version, gateway state, active
    # session count, and the dashboard auth-gate shape. No bodies, no
    # session content, no secrets. Documented as the portal's wildcard
    # liveness probe in
    # ``docs/agent-dashboard-public-url-contract.md`` (NAS side).
    "/api/status",
    # Read-only config-defaults / schema feeds for the SPA's Config page.
    "/api/config/defaults",
    "/api/config/schema",
    # Read-only model metadata (context windows, etc.) — same shape as
    # provider catalogs already exposed on the public internet.
    "/api/model/info",
    # Read-only theme + plugin manifests for the dashboard skin engine.
    "/api/dashboard/themes",
    "/api/dashboard/plugins",
    # Chronos managed-cron fire webhook (NAS -> agent). NOT cookie-gated: it
    # carries its own short-lived NAS-minted JWT (purpose=cron_fire), which the
    # handler verifies as the real auth. Must bypass the dashboard auth gate so
    # the NAS relay's bearer-only callback reaches the verifier instead of a
    # 401 no_cookie. The JWT — not this allowlist — is the security boundary.
    "/api/cron/fire",
    # FG-26 activation and password-recovery request. Unauthenticated by
    # definition: the invitee has no account to log in with yet, so gating these
    # makes activation impossible on precisely the deployments that have a gate
    # (the box 401'd every activation with `no_cookie`). Neither is a read: the
    # security boundary is the invitation itself — a single-use token stored only
    # as a SHA-256 hash, expiring in five minutes, rate-limited per IP and per
    # token, with every failure answering one identical body so the endpoint
    # cannot be used to enumerate accounts or probe token state. The request
    # endpoint never returns a link (an admin hands it over) and always answers
    # `{"ok": true}`.
    "/api/auth/invitations/redeem",
    "/api/auth/invitations/request",
    # First-run owner setup (hermes_cli/first_run.py). Unauthenticated because
    # the owner has no login yet; the boundary is a one-time 256-bit token from
    # `hermes setup-link` (stored hashed, 24 h, rate-limited, neutral errors).
    # With no token minted both refuse everything.
    "/api/setup/check",
    "/api/setup/owner",
    # Seminar survey (hermes_cli/seminar_survey.py). Unauthenticated by
    # definition: attendees have no account. Both are keyed by a 192-bit token
    # that was only ever sent into the attendee's own WhatsApp chat, and are
    # throttled per IP and per token.
    "/api/seminar/survey/state",
    "/api/seminar/survey/submit",
})
