/**
 * GET /api/projects/:slug — the whole record in one read (design §12).
 * PATCH /api/projects/:slug — record fields, lead/admin (§11).
 * DELETE /api/projects/:slug — hard delete (decision 17): human-only
 * upstream, `?confirm=<slug>` must name the slug; upstream statuses pass
 * through so the dialog can say *why* a delete was refused.
 * `&purge=smoke` is forwarded for the e2e/smoke cleanup: upstream lets the
 * creator purge an archived `[smoke]` project together with its history
 * (runs, cards, run sessions) and refuses everything else.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.project(slug));
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = await readBody(req);
  if (Object.keys(body).length === 0) {
    return NextResponse.json(
      { error: "invalid_request", detail: "Nothing to patch." },
      { status: 400 },
    );
  }
  return withPrincipal((client) => client.updateProject(slug, body));
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const search = new URL(req.url).searchParams;
  const confirm = search.get("confirm") ?? "";
  const purge = search.get("purge");
  return withPrincipal((client) =>
    purge === null
      ? client.deleteProject(slug, confirm)
      : client.deleteProject(slug, confirm, { purge }),
  );
}
