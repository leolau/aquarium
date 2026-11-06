/**
 * POST /api/projects/:slug/quick-task/start — carry a task on from where it
 * stopped: approve the proposed plan and start, Retry after a failure, or
 * redraft when no plan landed.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../../hermes-bridge";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  return withPrincipal((client) => client.startQuickTask(slug));
}
