/**
 * BFF for the users list + user creation (FG-26).
 *
 * - `GET`  → one page of this profile's roster (search / role / activity
 *   filters and paging are forwarded, and resolved in Postgres upstream, so a
 *   thousand-person roster costs the same as a ten-person one).
 * - `POST` → enrol somebody: a new account is created **banned with a
 *   server-side random password** and the response carries a one-time
 *   activation link. No password crosses this boundary in either direction.
 *
 * `profile` is required on create and is forwarded verbatim. A value naming
 * another profile is refused upstream with 409 before any account exists —
 * this route must not "helpfully" substitute the current profile, because that
 * would silently enrol somebody somewhere the admin didn't choose.
 *
 * FG-28: `?profile=` (or, on create, the body's `profile`; the two must agree)
 * names the profile administered. For a profile other than the session's the
 * owner/admin gate asks Python `whoami?profile=` for the caller's role there.
 *
 * Authorization is owner/admin and enforced **twice**: here for a clean UX, and
 * independently in Python as the authority. The browser never calls GoTrue.
 */
import { NextResponse } from "next/server";

import { bodyTarget, forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";
import type { Role } from "@/types";

interface CreateBody {
  email?: unknown;
  profile?: unknown;
  display?: unknown;
  role?: unknown;
}

const ASSIGNABLE: readonly string[] = ["admin", "member", "viewer"];

function intParam(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function GET(request: Request): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const params = new URL(request.url).searchParams;
  const role = (params.get("role") ?? "").trim();
  const active = (params.get("active") ?? "").trim();
  try {
    return NextResponse.json(
      await gate.client.members({
        limit: intParam(params.get("limit"), 25),
        offset: intParam(params.get("offset"), 0),
        q: (params.get("q") ?? "").trim() || undefined,
        role: ASSIGNABLE.includes(role) || role === "owner" ? (role as Role) : undefined,
        active: active === "" ? undefined : active === "true",
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const target = bodyTarget(request, body.profile);
  if ("response" in target) return target.response;
  const gate = await requireMemberAdmin(request, target);
  if ("response" in gate) return gate.response;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const profile = target.profile ?? "";
  const display = typeof body.display === "string" ? body.display.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "member";
  if (!email) {
    return NextResponse.json(
      { error: "invalid_input", detail: "An email address is required." },
      { status: 400 },
    );
  }
  if (!profile) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: "A profile is required — choose which profile to enrol into.",
      },
      { status: 400 },
    );
  }
  if (!ASSIGNABLE.includes(role)) {
    return NextResponse.json(
      { error: "invalid_role", detail: "role must be admin, member, or viewer." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await gate.client.createMember({
        email,
        profile,
        display,
        role: role as Role,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
