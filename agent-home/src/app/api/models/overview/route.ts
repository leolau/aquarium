/**
 * GET /api/models/overview — one-shot payload for the Models page: the
 * resolved main model, every auxiliary task-slot assignment, and 30-day
 * per-model usage. Fans out to three Python endpoints in parallel so the
 * page pays one round trip, not three.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    // Analytics is additive — a usage read failing must not blank the
    // configuration the page exists to show.
    const [info, auxiliary, analytics, fallback] = await Promise.all([
      client.modelInfo(),
      client.auxiliaryModels(),
      client.modelsAnalytics(30).catch(() => null),
      client.fallbackModels().catch(() => null),
    ]);
    return NextResponse.json({
      info,
      auxiliary,
      usage: analytics?.models ?? [],
      fallback: fallback?.providers,
      last_resort: fallback?.last_resort ?? null,
    });
  } catch (err) {
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
}
