/**
 * /api/me/creature — the signed-in person's aquarium creature (FG-35).
 * GET: `{creature, chosen}`. PUT {creature}: save it. The Python API derives
 * who from the session; no user id is accepted here.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { isCreatureId } from "@/lib/aquarium/creatures";

export async function GET(): Promise<NextResponse> {
  return withPrincipal((client) => client.myCreature());
}

export async function PUT(req: Request): Promise<NextResponse> {
  const { creature } = await readBody(req);
  if (!isCreatureId(creature)) {
    return NextResponse.json({ error: "invalid_body", detail: "unknown creature" }, { status: 400 });
  }
  return withPrincipal((client) => client.setMyCreature(creature));
}
