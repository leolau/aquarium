/** Shared forwarding for the `/api/telegram-bot` BFF routes (callers check the principal). */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest } from "@/lib/auth/principal";
import type { TelegramBotView } from "@/types";

export async function forwardTelegramBot(
  call: (client: Awaited<ReturnType<typeof apiClientForRequest>>) => Promise<TelegramBotView>,
): Promise<NextResponse> {
  try {
    return NextResponse.json(await call(await apiClientForRequest()));
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

export function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
