/**
 * POST /api/telegram-bot/{test,link/start,link/check} and
 * DELETE /api/telegram-bot/link — the caller's own bot actions.
 */
import { NextResponse } from "next/server";

import { getPrincipal } from "@/lib/auth/principal";
import { forwardTelegramBot as forward, unauthenticated } from "@/lib/telegramBotBff";
import type { TelegramBotAction } from "@/lib/api/client";

type Ctx = { params: Promise<{ action: string[] }> };

const POST_ACTIONS: ReadonlySet<string> = new Set(["test", "link/start", "link/check"]);

async function actionOf(ctx: Ctx): Promise<string> {
  return (await ctx.params).action.join("/");
}

export async function POST(_request: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const action = await actionOf(ctx);
  if (!POST_ACTIONS.has(action)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return forward((client) => client.telegramBotAction(action as TelegramBotAction));
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  if ((await actionOf(ctx)) !== "link") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return forward((client) => client.telegramBotAction("link", "DELETE"));
}
