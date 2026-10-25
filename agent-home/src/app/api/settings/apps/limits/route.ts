/**
 * /api/settings/apps/limits — Settings -> App limits (FG-33 decision 8).
 * GET the per-role defaults; PUT {limits: {member|admin: {per_app, per_member} | null}}.
 * Owner/admin only; only the owner may change the admin tier (Python enforces).
 */
import type { NextResponse } from "next/server";

import { canAdminister } from "@/lib/auth/roles";

import { badBody, forward, gate, readObject } from "../forward";

const PATH = "/api/quotas/defaults";

export async function GET(): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  return denied ?? forward(PATH, "GET");
}

export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  if (denied) return denied;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const limits = body.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return badBody("Send limits: {member|admin: {per_app, per_member}}.");
  }
  for (const [tier, sections] of Object.entries(limits)) {
    if (tier !== "member" && tier !== "admin") return badBody(`Unknown tier ${tier}.`);
    if (sections === null) continue;
    if (typeof sections !== "object" || Array.isArray(sections)) return badBody(`${tier} must be an object.`);
    for (const values of Object.values(sections as Record<string, unknown>)) {
      if (!values || typeof values !== "object") return badBody("Limits must be numbers.");
      for (const v of Object.values(values as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          return badBody("Limits must be whole numbers of 0 or more.");
        }
      }
    }
  }
  return forward(PATH, "PUT", { limits });
}
