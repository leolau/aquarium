/**
 * FG-33 decision 4: local apps share this origin under `/apps/*` and
 * `/apps-dev/*`, so refuse agent-home requests that an app page made
 * (see `lib/apps/guard.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { guardAgentHomeRequest } from "@/lib/apps/guard";

export function middleware(request: NextRequest): NextResponse {
  const verdict = guardAgentHomeRequest(request.method, request.nextUrl.pathname, request.headers);
  if (verdict.ok) return NextResponse.next();
  return NextResponse.json({ error: "forbidden", detail: verdict.reason }, { status: 403 });
}

export const config = {
  // Node runtime: an edge bundle would also pull instrumentation.ts (undici).
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
