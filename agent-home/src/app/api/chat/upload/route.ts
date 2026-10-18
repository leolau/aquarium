/**
 * POST /api/chat/upload — BFF chat-media upload (FG-20 Wave C1).
 *
 * Accepts a `multipart/form-data` file, uploads it to principal-scoped Supabase
 * Storage server-side (the browser never holds the storage key), and returns
 * the attachment reference the composer attaches to the outgoing message.
 * Responds 501 when Storage is not configured on the box.
 *
 * The upload is also recorded in the inbound file registry, so a file sent from
 * here shows up on `/files` beside the ones that arrived over Telegram or email.
 * Registration is best-effort: it must not be able to fail an upload the user
 * already watched succeed.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { uploadMaxBytes, uploadTooLargeDetail } from "@/lib/chat/upload-limit";
import { MULTIPART_SLACK_BYTES, uploadSpaceRefusal } from "@/lib/chat/upload-space";
import { mediaBucket } from "@/lib/env";
import { storageAvailable, uploadChatMedia } from "@/lib/supabase/storage";

/** SHA-256 of the bytes — the registry's identity for a file. */
/**
 * The multipart body is a little larger than the file, so this only refuses a
 * request that is over the optional cap or bigger than the free disk space.
 */
async function refuseByContentLength(request: Request): Promise<NextResponse | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length <= 0) return null;
  const maxBytes = uploadMaxBytes();
  if (length > maxBytes + MULTIPART_SLACK_BYTES) {
    return NextResponse.json(
      { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
      { status: 413 },
    );
  }
  return uploadSpaceRefusal(length - MULTIPART_SLACK_BYTES);
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!storageAvailable()) {
    return NextResponse.json(
      { error: "storage_unconfigured", detail: "Media storage is not configured." },
      { status: 501 },
    );
  }

  // Refuse before reading the body: formData() buffers the whole upload.
  const earlyRefusal = await refuseByContentLength(request);
  if (earlyRefusal) return earlyRefusal;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }
  const sessionId = (form.get("sessionId") as string | null) ?? "";
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing_file", detail: "A file field is required." },
      { status: 400 },
    );
  }
  const maxBytes = uploadMaxBytes();
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
      { status: 413 },
    );
  }
  const noSpace = await uploadSpaceRefusal(file.size);
  if (noSpace) return noSpace;

  try {
    const bytes = await file.arrayBuffer();
    const attachment = await uploadChatMedia(principal, sessionId, {
      name: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      bytes,
    });
    try {
      const client = await apiClientForRequest();
      await client.registerFile({
        filename: attachment.name,
        content_type: attachment.content_type,
        byte_size: attachment.size,
        sha256: await digest(bytes),
        storage_bucket: mediaBucket(),
        storage_path: attachment.path,
        conversation: sessionId || undefined,
      });
    } catch {
      // The bytes are safely in the bucket; a missing registry row is
      // repairable by the backfill, so this never fails the upload.
    }
    return NextResponse.json(attachment);
  } catch (err) {
    return NextResponse.json(
      {
        error: "upload_failed",
        detail: err instanceof Error ? err.message : "Upload failed.",
      },
      { status: 502 },
    );
  }
}
