/**
 * POST /api/session/login — the C1 principal bridge login (FG-20 Wave A2).
 *
 * Flow (Decision 1 = BRIDGE):
 *   1. Forward the submitted credentials to the Python API's existing
 *      `dashboard_auth` password-login (`POST /auth/password-login`). With no
 *      `provider` (or `"auto"`) the route picks one from `/api/auth/providers`:
 *      an `@` prefers the email provider, else the username one; a wrong
 *      password or unknown provider tries the other password provider once.
 *   2. Capture the upstream `hermes_session_at` token from its `Set-Cookie`.
 *   3. Choose the landing profile among the account's active enrolments
 *      (`/api/auth/my-profiles`, FG-28 D1): `?profile=` from the login URL,
 *      then this browser's signed last-profile hint, then `default`, then the
 *      first in registry order.
 *   4. Resolve the C1 principal for that token *in that profile*
 *      (`/api/comms/whoami?profile=`), so the role is that profile's.
 *   5. Mint the signed `agent-home` session cookie carrying the token, the
 *      profile and the principal snapshot; remember the profile as the hint.
 *
 * `agent-home` never verifies the password itself — the Python
 * `dashboard_auth` provider remains the single credential authority.
 */
import { NextResponse } from "next/server";

import { hermesApiBaseUrl } from "@/lib/env";
import { resolvePrincipalOrStatus } from "@/lib/auth/principal";
import { chooseLandingProfile, type LandingChoice } from "@/lib/auth/landing-profile";
import { readLastProfileHint, writeLastProfileHint, writeSession } from "@/lib/auth/session";
import { syncLanguageAtLogin } from "@/i18n/sync";
import { HermesApiClient } from "@/lib/api/client";
import { passwordProviderOrder } from "@/lib/auth/password-providers";

interface LoginBody {
  /** A provider name, or missing / `"auto"` to choose from the identifier. */
  provider?: unknown;
  username?: unknown;
  password?: unknown;
  /** Second step when the login has two-factor on: app or recovery code. */
  code?: unknown;
  /** The profile `/login?profile=` asked for; honoured only if enrolled. */
  profile?: unknown;
}

const SUSPENDED_DETAIL =
  "Your access to this profile has been suspended. Ask an administrator to restore it.";
const NO_PRINCIPAL_DETAIL = "Authenticated, but no C1 principal is enrolled for this user.";

/**
 * The landing profile for a fresh token. When the enrolment list cannot be
 * read (an older AI layer, a hiccup) the login falls back to the default
 * profile as before; `whoami` there is still the authority.
 */
async function landingFor(token: string, requested: string): Promise<LandingChoice> {
  let enrolments;
  try {
    enrolments = (await new HermesApiClient({ hermesToken: token }).myProfiles()).profiles ?? [];
  } catch {
    return { kind: "profile", profile: "default" };
  }
  return chooseLandingProfile(enrolments, { requested, hint: await readLastProfileHint() });
}

function unreachable(): NextResponse {
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}

/** Pull the upstream `hermes_session_at` value out of Set-Cookie headers. */
function extractHermesToken(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    // Cookie name may be bare or carry a `__Host-` / `__Secure-` prefix.
    const match = raw.match(/(?:^|;\s*)(?:__Host-|__Secure-)?hermes_session_at=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const requestedProvider =
    typeof body.provider === "string" && body.provider !== "auto" ? body.provider : "";
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const requestedProfile = typeof body.profile === "string" ? body.profile.trim() : "";
  if (!username || !password) {
    return NextResponse.json(
      { error: "missing_fields", detail: "username and password are required" },
      { status: 400 },
    );
  }

  let candidates: string[];
  if (requestedProvider) {
    candidates = [requestedProvider];
  } else {
    try {
      candidates = passwordProviderOrder(username, (await new HermesApiClient().authProviders()).providers ?? []);
    } catch {
      return unreachable();
    }
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "no_provider", detail: "No password provider is configured." },
        { status: 400 },
      );
    }
  }

  let upstream: Response | null = null;
  let provider = "";
  for (const [i, name] of candidates.entries()) {
    try {
      upstream = await fetch(`${hermesApiBaseUrl()}/auth/password-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          code ? { provider: name, username, password, code } : { provider: name, username, password },
        ),
        cache: "no-store",
      });
    } catch {
      return unreachable();
    }
    provider = name;
    // Only a wrong password / unknown provider earns the one fallback; a
    // rate limit, a provider outage or a code check is final.
    const tryNext = !code && (upstream.status === 401 || upstream.status === 404) && i < candidates.length - 1;
    if (!tryNext) break;
  }
  if (!upstream) return unreachable();

  if (upstream.status === 429) {
    return NextResponse.json(
      { error: "too_many_attempts", detail: "Too many tries. Wait a few minutes and try again." },
      { status: 429 },
    );
  }
  if (!upstream.ok && code && upstream.status === 401) {
    return NextResponse.json(
      { error: "invalid_code", detail: "That code doesn't match." },
      { status: 401 },
    );
  }
  if (!upstream.ok) {
    // Deliberately generic, like the Python endpoint: never say which part
    // (identifier, password or provider) was wrong.
    const wrong = upstream.status === 401 || upstream.status === 404;
    return NextResponse.json(
      {
        error: "login_failed",
        detail: wrong ? "Wrong email/username or password." : "Sign-in failed.",
      },
      { status: wrong ? 401 : upstream.status },
    );
  }

  const answer = (await upstream.clone().json().catch(() => null)) as {
    two_factor_required?: unknown;
  } | null;
  if (answer?.two_factor_required === true) {
    // Password was right; this login has two-factor on. No session yet: the
    // form asks for a code and sends the password again with it, to the
    // provider named here.
    return NextResponse.json({ ok: false, two_factor_required: true, provider });
  }

  const token = extractHermesToken(upstream.headers.getSetCookie());
  if (!token) {
    return NextResponse.json(
      { error: "no_session", detail: "Upstream login returned no session token." },
      { status: 502 },
    );
  }

  const landing = await landingFor(token, requestedProfile);
  // The credentials were right: the account is shared box-wide and it is the
  // enrolment that is missing or switched off, so saying "invalid password"
  // would send them round the reset loop for nothing.
  if (landing.kind === "suspended") {
    return NextResponse.json({ error: "suspended", detail: SUSPENDED_DETAIL }, { status: 403 });
  }
  if (landing.kind === "none") {
    return NextResponse.json({ error: "no_principal", detail: NO_PRINCIPAL_DETAIL }, { status: 409 });
  }
  const profile = landing.profile;

  const resolved = await resolvePrincipalOrStatus(token, profile);
  if (resolved.kind === "suspended") {
    return NextResponse.json({ error: "suspended", detail: SUSPENDED_DETAIL }, { status: 403 });
  }
  if (resolved.kind === "none") {
    return NextResponse.json({ error: "no_principal", detail: NO_PRINCIPAL_DETAIL }, { status: 409 });
  }
  const principal = resolved.principal;

  await writeSession({
    hermesToken: token,
    profile,
    principal,
    issuedAt: Math.floor(Date.now() / 1000),
  });
  await writeLastProfileHint(profile);
  await syncLanguageAtLogin(new HermesApiClient({ hermesToken: token }));
  return NextResponse.json({ ok: true, principal, profile });
}
