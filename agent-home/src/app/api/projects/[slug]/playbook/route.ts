/**
 * GET /api/projects/:slug/playbook — the method: active revision + all
 * revisions (§7).
 * POST — propose revision N+1 (inactive). Open to `member`; only a lead may
 * activate. Cycle-checked at save time (§7.1).
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.projectPlaybook(slug));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  const steps = body.steps;
  if (!Array.isArray(steps)) {
    return NextResponse.json(
      { error: "invalid_request", detail: "A playbook needs a steps array." },
      { status: 400 },
    );
  }
  return withPrincipal((client) =>
    client.saveProjectPlaybook(slug, {
      body: body.body !== undefined ? String(body.body) : undefined,
      steps,
      note: body.note !== undefined ? String(body.note) : undefined,
      base_rev: Number.isInteger(body.base_rev) ? (body.base_rev as number) : undefined,
    }),
  );
}
