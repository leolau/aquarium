/**
 * POST /api/browse/attach `{place, path}` — "Ask the agent about this file":
 * copy the file into chat media exactly like a composer upload
 * (`/api/chat/upload`) and return the attachment the composer adds to the
 * next message. Like an upload, it is also recorded on Files → Arrived.
 */
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import {
  badRequest,
  baseName,
  browseFail,
  placeAndPath,
  unauthenticated,
} from "@/lib/browse/bff";
import { uploadMaxBytes, uploadTooLargeDetail } from "@/lib/chat/upload-limit";
import { uploadSpaceRefusal } from "@/lib/chat/upload-space";
import { mediaBucket } from "@/lib/env";
import { storageAvailable, uploadChatMedia } from "@/lib/supabase/storage";

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  if (!storageAvailable()) {
    return NextResponse.json(
      { error: "storage_unconfigured", detail: "Media storage is not configured." },
      { status: 501 },
    );
  }
  const target = placeAndPath(await req.json().catch(() => null), { pathRequired: true });
  if (!target) return badRequest();
  try {
    const client = await apiClientForRequest();
    const upstream = await client.browseFile(target.place, target.path);
    const size = Number(upstream.headers.get("content-length") ?? "0");
    const maxBytes = uploadMaxBytes();
    if (size > maxBytes) {
      await upstream.body?.cancel();
      return NextResponse.json(
        { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
        { status: 413 },
      );
    }
    const noSpace = await uploadSpaceRefusal(size);
    if (noSpace) {
      await upstream.body?.cancel();
      return noSpace;
    }
    const bytes = await upstream.arrayBuffer();
    const attachment = await uploadChatMedia(principal, "", {
      name: baseName(target.path),
      contentType: upstream.headers.get("content-type") || "application/octet-stream",
      bytes,
    });
    try {
      await client.registerFile({
        filename: attachment.name,
        content_type: attachment.content_type,
        byte_size: attachment.size,
        sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
        storage_bucket: mediaBucket(),
        storage_path: attachment.path,
      });
    } catch {
      // Same as a composer upload: the bytes are stored; a missing registry
      // row is repairable and must not fail the attach.
    }
    return NextResponse.json(attachment);
  } catch (err) {
    return browseFail(err);
  }
}
