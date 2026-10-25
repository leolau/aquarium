/**
 * PATCH /api/project-categories/:id — rename / recolour / reorder.
 * DELETE /api/project-categories/:id — remove; its projects become
 * Uncategorized (the projects themselves are untouched otherwise).
 */
import { NextResponse } from "next/server";

import { invalidRequest, readBody, withPrincipal } from "../../projects/hermes-bridge";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await readBody(req);
  const payload: { name?: string; color?: string | null; position?: number } = {};
  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name) return invalidRequest("A category needs a name.");
    payload.name = name;
  }
  if ("color" in body) {
    payload.color =
      typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
  }
  if ("position" in body) {
    const position = Number(body.position);
    if (!Number.isInteger(position)) return invalidRequest("position must be an integer.");
    payload.position = position;
  }
  if (Object.keys(payload).length === 0) return invalidRequest("Nothing to patch.");
  return withPrincipal((client) => client.updateProjectCategory(id, payload));
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return withPrincipal((client) => client.deleteProjectCategory(id));
}
