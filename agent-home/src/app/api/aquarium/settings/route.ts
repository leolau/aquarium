/**
 * /api/aquarium/settings — seconds before the aquarium dashboard goes idle
 * (config.yaml `aquarium.idle_seconds`, box-wide).
 * GET: any signed-in person. PUT {idle_seconds}: owner/admin only; Python
 * re-checks and validates.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { IDLE_SECONDS_MAX, IDLE_SECONDS_MIN } from "@/lib/aquarium/creatures";
import { getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  return withPrincipal((client) => client.aquariumSettings());
}

export async function PUT(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: "Only the owner or an admin can change the aquarium." },
      { status: 403 },
    );
  }
  const { idle_seconds: idle } = await readBody(req);
  if (
    typeof idle !== "number" ||
    !Number.isInteger(idle) ||
    idle < IDLE_SECONDS_MIN ||
    idle > IDLE_SECONDS_MAX
  ) {
    return NextResponse.json(
      {
        error: "invalid_body",
        detail: `idle_seconds must be a whole number between ${IDLE_SECONDS_MIN} and ${IDLE_SECONDS_MAX}.`,
      },
      { status: 400 },
    );
  }
  return withPrincipal((client) => client.setAquariumSettings(idle));
}
