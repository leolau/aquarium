/**
 * /api/aquarium/settings — the box-wide aquarium settings (config.yaml
 * `aquarium.idle_seconds` and `aquarium.name`).
 * GET: any signed-in person. PUT any subset of {idle_seconds, name}:
 * owner/admin only; returns all of them. Python re-checks and validates.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import {
  AQUARIUM_NAME_MAX,
  IDLE_SECONDS_MAX,
  IDLE_SECONDS_MIN,
  type AquariumSettings,
} from "@/lib/aquarium/creatures";
import { getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

// eslint-disable-next-line no-control-regex
const NAME_STRIPPED = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function invalid(detail: string): NextResponse {
  return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
}

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
  const raw: unknown = await readBody(req);
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const patch: Partial<AquariumSettings> = {};
  if ("idle_seconds" in body) {
    const idle = body.idle_seconds;
    if (
      typeof idle !== "number" ||
      !Number.isInteger(idle) ||
      idle < IDLE_SECONDS_MIN ||
      idle > IDLE_SECONDS_MAX
    ) {
      return invalid(
        `idle_seconds must be a whole number between ${IDLE_SECONDS_MIN} and ${IDLE_SECONDS_MAX}.`,
      );
    }
    patch.idle_seconds = idle;
  }
  if ("name" in body) {
    const name = body.name;
    if (typeof name !== "string") return invalid("name must be a string.");
    if ([...name.replace(NAME_STRIPPED, "").trim()].length > AQUARIUM_NAME_MAX) {
      return invalid(`name must be at most ${AQUARIUM_NAME_MAX} characters.`);
    }
    patch.name = name;
  }
  if (Object.keys(patch).length === 0) return invalid("Give idle_seconds and/or name.");
  return withPrincipal((client) => client.setAquariumSettings(patch));
}
