/**
 * /api/backups/offsite — Get ready item 10 (Backups). Owner only, here and in
 * the Python API. GET = status, PUT = check + save storage settings, DELETE =
 * stop offsite backups. The storage secret goes up once and never comes back.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { requireMemberOwner } from "@/lib/api/member-bff";

const OWNER_ONLY = "Only the owner can manage backups.";

function failure(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json(
      { error: "api_error", detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}

export async function GET(): Promise<NextResponse> {
  const gate = await requireMemberOwner(OWNER_ONLY);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.offsiteBackup());
  } catch (err) {
    return failure(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const gate = await requireMemberOwner(OWNER_ONLY);
  if ("response" in gate) return gate.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await gate.client.configureOffsiteBackup(body as Record<string, unknown>),
    );
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(): Promise<NextResponse> {
  const gate = await requireMemberOwner(OWNER_ONLY);
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.removeOffsiteBackup());
  } catch (err) {
    return failure(err);
  }
}
