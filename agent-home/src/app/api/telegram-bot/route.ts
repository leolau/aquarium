/**
 * /api/telegram-bot — BFF for the caller's own Telegram bot (Get ready item 6).
 *
 * GET reads, PUT saves `{ token }` (Hermes checks it with Telegram getMe),
 * DELETE removes it. Hermes scopes every call to the signed-in person and
 * never returns the token; this layer only forwards.
 */
import { NextResponse } from "next/server";

import { getPrincipal } from "@/lib/auth/principal";
import { forwardTelegramBot as forward, unauthenticated } from "@/lib/telegramBotBff";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  return forward((client) => client.telegramBot());
}

export async function PUT(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  let token = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body?.token === "string" ? body.token.trim() : "";
  } catch {
    token = "";
  }
  if (!token) {
    return NextResponse.json({ error: "bad_request", detail: "invalid_token" }, { status: 400 });
  }
  return forward((client) => client.saveTelegramBot(token));
}

export async function DELETE(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  return forward((client) => client.removeTelegramBot());
}
