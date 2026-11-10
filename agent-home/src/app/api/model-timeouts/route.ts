/**
 * /api/model-timeouts — model API timeouts per provider and per model
 * (config.yaml `providers.<id>.request_timeout_seconds` and
 * `providers.<id>.models.<model>.timeout_seconds`, in every profile).
 * GET and PUT {provider, model, timeout_seconds}: owner/admin only;
 * `timeout_seconds: null` clears one. Python re-checks and validates.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import {
  TIMEOUT_MAX_SECONDS,
  TIMEOUT_MIN_SECONDS,
  type ModelTimeoutChange,
} from "@/lib/model-timeouts";

function invalid(detail: string): NextResponse {
  return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
}

const UNAUTHENTICATED = { error: "unauthenticated" };
const FORBIDDEN = {
  error: "forbidden",
  detail: "Only the owner or an admin can change model timeouts.",
};

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json(UNAUTHENTICATED, { status: 401 });
  if (!canAdminister(principal)) return NextResponse.json(FORBIDDEN, { status: 403 });
  return withPrincipal((client) => client.modelTimeouts());
}

export async function PUT(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json(UNAUTHENTICATED, { status: 401 });
  if (!canAdminister(principal)) return NextResponse.json(FORBIDDEN, { status: 403 });
  const raw: unknown = await readBody(req);
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const { provider, model, timeout_seconds: seconds } = body;
  if (typeof provider !== "string" || provider.trim() === "") return invalid("provider is required.");
  if (model !== undefined && model !== null && typeof model !== "string") {
    return invalid("model must be text or null.");
  }
  if (!("timeout_seconds" in body)) return invalid("Give timeout_seconds (or null to clear it).");
  if (
    seconds !== null &&
    (typeof seconds !== "number" || seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS)
  ) {
    return invalid(
      `timeout_seconds must be between ${TIMEOUT_MIN_SECONDS} and ${TIMEOUT_MAX_SECONDS}, or null.`,
    );
  }
  const change: ModelTimeoutChange = {
    provider: provider.trim(),
    model: typeof model === "string" && model.trim() !== "" ? model.trim() : null,
    timeout_seconds: seconds as number | null,
  };
  return withPrincipal((client) => client.setModelTimeout(change));
}
