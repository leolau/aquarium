/**
 * PUT /api/me/project-view-mode — save the signed-in person's Projects view
 * (Task mode or Project mode) for one device class. The Python API derives
 * who from the session; no user id is accepted here.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { isProjectViewMode, isViewDevice } from "@/components/projects/task/viewMode";

export async function PUT(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  if (!isViewDevice(body.device) || !isProjectViewMode(body.mode)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { device, mode } = body;
  return withPrincipal((client) => client.setMyProjectViewMode(device, mode));
}
