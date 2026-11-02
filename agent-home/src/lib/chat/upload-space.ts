/**
 * Upload policy for the BFF upload routes: the configured size limit and the
 * free space on the disk holding the upload store, read in one call to
 * `/api/capacity/upload-storage`. Any failure to read it falls back to the
 * default limit and lets the free-space check through — the guard must never
 * block a working box.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest } from "@/lib/auth/principal";
import { resolveUploadMaxBytes, uploadTooLargeDetail } from "@/lib/chat/upload-limit";

const GB = 1024 ** 3;

/** Room for multipart boundaries and form fields around the file itself. */
export const MULTIPART_SLACK_BYTES = 64 * 1024;

export interface UploadPolicy {
  maxBytes: number;
  freeBytes: number | null;
}

function fmtGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function notEnoughSpaceDetail(size: number, free: number): string {
  return `Not enough storage space on the server: this file is ${fmtGb(size)} but only ${fmtGb(free)} is free. Ask an admin to free up space.`;
}

export async function uploadPolicy(): Promise<UploadPolicy> {
  try {
    const client = await apiClientForRequest();
    const storage = await client.uploadStorage();
    return {
      maxBytes: resolveUploadMaxBytes(storage?.max_bytes),
      freeBytes: typeof storage?.free_bytes === "number" ? storage.free_bytes : null,
    };
  } catch {
    return { maxBytes: resolveUploadMaxBytes(undefined), freeBytes: null };
  }
}

export function tooLarge(maxBytes: number): NextResponse {
  return NextResponse.json(
    { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
    { status: 413 },
  );
}

/** 413 over the limit, 507 when it clearly cannot fit; null when allowed. */
export function uploadRefusal(size: number, policy: UploadPolicy): NextResponse | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size > policy.maxBytes) return tooLarge(policy.maxBytes);
  const free = policy.freeBytes;
  if (free === null || size <= free) return null;
  return NextResponse.json(
    { error: "insufficient_storage", detail: notEnoughSpaceDetail(size, free) },
    { status: 507 },
  );
}

/** Free-space check alone (callers that apply the size limit themselves). */
export async function uploadSpaceRefusal(size: number): Promise<NextResponse | null> {
  const { freeBytes } = await uploadPolicy();
  return uploadRefusal(size, { maxBytes: Number.POSITIVE_INFINITY, freeBytes });
}
