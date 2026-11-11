/**
 * POST /api/projects/:slug/skills/candidates/:id/dismiss — hide a
 * retro-suggested skill (`dismissed_at`). Project writers, or Skills `lab`
 * in the host profile; refused on archived projects.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../../../hermes-bridge";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
): Promise<NextResponse> {
  const { slug, id } = await params;
  return withPrincipal((client) => client.dismissProjectSkillCandidate(slug, id));
}
