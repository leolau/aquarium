import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";

/**
 * Shared by the first-run setup proxies. Upstream answers every token problem
 * with the same neutral 400, so this passes the status and message through
 * unchanged and adds no judgement of its own. The token is never logged.
 */
export async function readSetupBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function setupFailure(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json(
      { error: "setup_failed", detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}
