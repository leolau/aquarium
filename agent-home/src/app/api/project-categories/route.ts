/**
 * GET /api/project-categories — the instance's project categories (kanban
 * columns on `/projects`), in column order.
 * POST /api/project-categories — add one (`{ name, color? }`).
 *
 * Lives outside `/api/projects/` so a project slugged `categories` is never
 * shadowed. Forwards to Python `/api/registry/project-categories`.
 */
import { NextResponse } from "next/server";

import { invalidRequest, readBody, withPrincipal } from "../projects/hermes-bridge";

export async function GET(): Promise<NextResponse> {
  return withPrincipal((client) => client.projectCategories());
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();
  if (!name) return invalidRequest("A category needs a name.");
  const color =
    typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
  return withPrincipal((client) => client.createProjectCategory({ name, color }));
}
