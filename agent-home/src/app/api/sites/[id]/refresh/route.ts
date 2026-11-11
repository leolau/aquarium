/**
 * POST /api/sites/{id}/refresh {entities?, mode?} — Refresh now (runs in the
 * Hermes backend, no LLM). Site admins only; Hermes checks.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SiteRefreshMode } from "@/types/sites";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  const entities = body.entities;
  if (entities !== undefined && (!Array.isArray(entities) || !entities.every((e) => typeof e === "string"))) {
    return NextResponse.json({ error: "invalid_body", detail: "entities must be a list of names." }, { status: 400 });
  }
  const mode = body.mode;
  if (mode !== undefined && mode !== "incremental" && mode !== "full") {
    return NextResponse.json({ error: "invalid_body", detail: "mode must be incremental or full." }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    const out = await client.refreshSite(id, {
      ...(entities ? { entities: entities as string[] } : {}),
      ...(mode ? { mode: mode as SiteRefreshMode } : {}),
    });
    return NextResponse.json(out, { status: 202 });
  } catch (err) {
    return hermesError(err);
  }
}
