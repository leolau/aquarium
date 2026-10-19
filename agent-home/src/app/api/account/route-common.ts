import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function accountFailure(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json({ error: "api_error", detail: err.message }, { status: err.status });
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}
