/**
 * Free-space guard for uploads. Uploads are unlimited by default (see
 * `upload-limit.ts`); the only refusal here is for a file that clearly cannot
 * fit on the disk holding the upload store. Any failure to read free space
 * lets the upload through — the guard must never block a working box.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest } from "@/lib/auth/principal";

const GB = 1024 ** 3;

/** Room for multipart boundaries and form fields around the file itself. */
export const MULTIPART_SLACK_BYTES = 64 * 1024;

function fmtGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function notEnoughSpaceDetail(size: number, free: number): string {
  return `Not enough storage space on the server: this file is ${fmtGb(size)} but only ${fmtGb(free)} is free. Ask an admin to free up space.`;
}

export async function uploadSpaceRefusal(size: number): Promise<NextResponse | null> {
  if (!Number.isFinite(size) || size <= 0) return null;
  let free: number | null = null;
  try {
    const client = await apiClientForRequest();
    const storage = await client.uploadStorage();
    free = typeof storage?.free_bytes === "number" ? storage.free_bytes : null;
  } catch {
    return null;
  }
  if (free === null || size <= free) return null;
  return NextResponse.json(
    { error: "insufficient_storage", detail: notEnoughSpaceDetail(size, free) },
    { status: 507 },
  );
}
