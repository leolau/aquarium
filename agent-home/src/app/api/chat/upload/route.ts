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
 *
 * Memory: `formData()` buffers the whole multipart body (undici), so an
 * upload costs about its own size in RSS while it is handled; the bytes then
 * stream to Storage (hashed on the way) without a second copy. The size
 * limit (Settings → Uploads, default 1 GB) bounds that; multi-GB files belong
 * on the chunked `/api/files/import` path, which spools to disk.
 *
 * DELETE {path} removes one of the caller's own uploaded-but-unsent objects.
 *
 * Not matched by the middleware (see `lib/http/body-route-guard.ts`), so each
 * handler runs `guardBodyRoute` first.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hashingStream } from "@/lib/chat/hashing-stream";
import { INVALID_FORM_DETAIL } from "@/lib/chat/upload-error";
import { logUploadFailure, type UploadFailureInfo } from "@/lib/chat/upload-log";
import { MULTIPART_SLACK_BYTES, uploadPolicy, uploadRefusal } from "@/lib/chat/upload-space";
import { mediaBucket } from "@/lib/env";
import { guardBodyRoute } from "@/lib/http/body-route-guard";
import { removeChatMedia, storageAvailable, uploadChatMediaStream } from "@/lib/supabase/storage";
import type { Principal } from "@/types";

const ROUTE = "/api/chat/upload";

export async function POST(request: Request): Promise<NextResponse> {
  const denied = await guardBodyRoute(request);
  if (denied) return denied;
  const principal = await getPrincipal();
  const info: UploadFailureInfo = {};
  const res = await handleUpload(request, principal, info);
  await logUploadFailure(ROUTE, request, res, info);
  return res;
}

async function handleUpload(
  request: Request,
  principal: Principal | null,
  info: UploadFailureInfo,
): Promise<NextResponse> {
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
  // The multipart body is a little larger than the file, hence the slack.
  const policy = await uploadPolicy();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MULTIPART_SLACK_BYTES) {
    const early = uploadRefusal(length - MULTIPART_SLACK_BYTES, policy);
    if (early) return early;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form", detail: INVALID_FORM_DETAIL }, { status: 400 });
  }
  const sessionId = (form.get("sessionId") as string | null) ?? "";
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing_file", detail: "A file field is required." },
      { status: 400 },
    );
  }
  info.fileSize = file.size;
  info.fileType = file.type;
  const refused = uploadRefusal(file.size, policy);
  if (refused) return refused;

  try {
    const hashed = hashingStream(file.stream());
    const stored = await uploadChatMediaStream(principal, sessionId, {
      name: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      body: hashed.stream,
    });
    const attachment = { ...stored, size: file.size };
    try {
      const client = await apiClientForRequest();
      await client.registerFile({
        filename: attachment.name,
        content_type: attachment.content_type,
        byte_size: attachment.size,
        sha256: hashed.digest(),
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

export async function DELETE(request: Request): Promise<NextResponse> {
  const denied = await guardBodyRoute(request);
  if (denied) return denied;
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
  let path = "";
  try {
    const body = (await request.json()) as { path?: unknown };
    path = typeof body?.path === "string" ? body.path : "";
  } catch {
    // fall through to the 400
  }
  if (!path) {
    return NextResponse.json({ error: "bad_body", detail: "Send {path}." }, { status: 400 });
  }
  try {
    if (!(await removeChatMedia(principal, path))) {
      return NextResponse.json({ error: "not_found", detail: "No such upload." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "delete_failed", detail: err instanceof Error ? err.message : "Delete failed." },
      { status: 502 },
    );
  }
}
