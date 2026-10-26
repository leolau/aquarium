/**
 * GET /api/projects — the readable projects list (design ed.3.2 §12).
 * POST /api/projects — create under the full §2.2 contract.
 *
 * Forwards to the Python `/api/registry/projects` under the bridged C1
 * principal, which scopes the rows: a project the caller cannot read is
 * simply absent, never a 403.
 */
import { NextResponse } from "next/server";

import type { CreateProjectPayload } from "@/types";

import { readBody, withPrincipal } from "./hermes-bridge";

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  return withPrincipal((client) =>
    client.projects({
      status: params.get("status") ?? undefined,
      cadence: params.get("cadence") ?? undefined,
      health: params.get("health") ?? undefined,
      q: params.get("q") ?? undefined,
      category: params.get("category") ?? undefined,
      archived: params.get("archived") === "true",
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
      cursor: params.get("cursor") ?? undefined,
    }),
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  // The §2.2 mandatory four — the Python layer re-checks all of them, but a
  // BFF-level refusal speaks the same `missing` shape the upstream 422 does
  // (U3), so the form maps the refusal onto the blank field either way.
  const goal = String(body.goal ?? "").trim();
  const description = String(body.description ?? "").trim();
  const hostProfile = String(body.host_profile ?? "").trim();
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];
  const hasOutput = outputs.some((output) =>
    String((output as { title?: unknown } | null)?.title ?? "").trim(),
  );
  const missing: string[] = [];
  if (!goal) missing.push("goal");
  if (!description) missing.push("description");
  if (outputs.length === 0 || !hasOutput) missing.push("outputs");
  if (!hostProfile) missing.push("host_profile");
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "invalid_request",
        detail: "A project needs its mandatory fields before it can start.",
        missing,
      },
      { status: 422 },
    );
  }
  return withPrincipal((client) =>
    client.createProject(body as unknown as CreateProjectPayload),
  );
}
