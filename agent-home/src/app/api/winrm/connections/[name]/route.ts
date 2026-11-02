/**
 * PUT / DELETE /api/winrm/connections/{name} — save or remove one of the
 * caller's own Windows servers. Hermes owns validation and the owner check.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { WinrmConnectionInput } from "@/types";

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { name } = await ctx.params;
  let body: WinrmConnectionInput;
  try {
    body = (await req.json()) as WinrmConnectionInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putWinrmConnection(name, body));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { name } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.deleteWinrmConnection(name));
  } catch (err) {
    return hermesError(err);
  }
}
