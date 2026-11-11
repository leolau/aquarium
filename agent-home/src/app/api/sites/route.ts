/**
 * GET /api/sites — the sites the caller may see; POST adds one (Settings ->
 * sites.create_roles). Hermes checks roles and grants; non-grantees never see a site.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SiteInput } from "@/types/sites";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.sites());
  } catch (err) {
    return hermesError(err);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.createSite(body as SiteInput));
  } catch (err) {
    return hermesError(err);
  }
}

