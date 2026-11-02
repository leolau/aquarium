/**
 * /api/settings/uploads — Settings → Uploads: the upload size limit
 * (config.yaml `agent_home.uploads.max_bytes`, default 1 GB).
 * GET: any signed-in person (the composer pre-checks files against it).
 * PUT {max_bytes}: owner/admin only; Python re-checks and validates.
 */
import { NextResponse } from "next/server";

import { canAdminister } from "@/lib/auth/roles";
import { getPrincipal } from "@/lib/auth/principal";
import { legacyUploadMaxBytes } from "@/lib/chat/upload-limit";
import type { UploadSettings } from "@/types";

import { badBody, forward, gate, readObject } from "../apps/forward";

const PATH = "/api/agent-home/uploads";

/** The deploy's legacy env override wins over the saved value; say so. */
const withOverride = (data: UploadSettings) => ({
  ...data,
  legacy_override_bytes: legacyUploadMaxBytes(),
});

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return forward<UploadSettings>(PATH, "GET", undefined, withOverride);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  if (denied) return denied;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const maxBytes = body.max_bytes;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return badBody("max_bytes must be a whole number of bytes.");
  }
  return forward<UploadSettings>(PATH, "PUT", { max_bytes: maxBytes }, withOverride);
}
