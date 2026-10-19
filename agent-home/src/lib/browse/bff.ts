/** Shared bits of the `/api/browse/*` BFF routes (Files → Browse). */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";

export function browseFail(err: unknown): NextResponse {
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

/** `{place, path}` from a query string or JSON body; `null` when malformed. */
export function placeAndPath(
  raw: { place?: unknown; path?: unknown } | null,
  { pathRequired }: { pathRequired: boolean },
): { place: string; path: string } | null {
  if (!raw || typeof raw.place !== "string" || !raw.place) return null;
  const path = raw.path ?? "";
  if (typeof path !== "string" || (pathRequired && !path)) return null;
  return { place: raw.place, path };
}

export function badRequest(): NextResponse {
  return NextResponse.json(
    { error: "bad_request", detail: "place and path are required" },
    { status: 400 },
  );
}

export function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

/** Last segment of a place-relative path. */
export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "file";
}
