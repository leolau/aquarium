/**
 * /api/settings/apps/storage — Settings -> App storage (FG-33 decision 21):
 * the base path for app source/releases, the apps DB volume and build caches,
 * and the free-space floor admission keeps there. Owner/admin only.
 */
import type { NextResponse } from "next/server";

import { canAdminister } from "@/lib/auth/roles";

import { badBody, forward, gate, readObject } from "../forward";

const PATH = "/api/quotas/storage";

export async function GET(): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  return denied ?? forward(PATH, "GET");
}

export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  if (denied) return denied;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const change: { base_path?: string; min_free_mb?: number } = {};
  if (body.base_path !== undefined) {
    if (typeof body.base_path !== "string" || !body.base_path.startsWith("/")) {
      return badBody("The storage location must be an absolute path.");
    }
    change.base_path = body.base_path.trim();
  }
  if (body.min_free_mb !== undefined) {
    const v = body.min_free_mb;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return badBody("Free space to keep must be a whole number of MB.");
    }
    change.min_free_mb = v;
  }
  if (!Object.keys(change).length) return badBody("Nothing to change.");
  return forward(PATH, "PUT", change);
}
