/**
 * GET /api/projects/:slug/skills?days=30|90 — the project Skills tab: skills
 * this project's card runs used, one row per (skill, profile), never merged
 * across profiles. Any project reader gets the summary; per-profile
 * `can_lab`/`can_manage` say which actions the caller may take there.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "../../hermes-bridge";

const WINDOWS = new Set([30, 90]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const asked = Number(new URL(req.url).searchParams.get("days"));
  const days = WINDOWS.has(asked) ? asked : 90;
  return withPrincipal((client) => client.projectSkills(slug, days));
}
