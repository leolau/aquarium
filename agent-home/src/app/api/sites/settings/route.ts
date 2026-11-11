/**
 * GET /api/sites/settings — who may add sites; PUT (owner/admin) changes it.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.siteSettings());
  } catch (err) {
    return hermesError(err);
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  if (!canAdminister(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: "Only the owner or an admin can change who may add sites." },
      { status: 403 },
    );
  }
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  if (!Array.isArray(body.create_roles) || !body.create_roles.every((r) => typeof r === "string")) {
    return NextResponse.json({ error: "invalid_body", detail: "create_roles must be a list of roles." }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putSiteSettings({ create_roles: body.create_roles as string[] }));
  } catch (err) {
    return hermesError(err);
  }
}
