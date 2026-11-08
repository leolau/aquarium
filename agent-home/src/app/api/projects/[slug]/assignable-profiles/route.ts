/**
 * GET /api/projects/:slug/assignable-profiles — profiles the caller may put
 * on a plan step, each with its description, skills and track record
 * (FG-34 C-2). Read access to the project is enough.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.projectAssignableProfiles(slug));
}
