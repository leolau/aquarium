/**
 * POST /api/projects/:slug/files/upload — upload bytes, register, and link.
 *
 * One round-trip that does what the chat upload route does plus the project
 * link: accepts a `multipart/form-data` file, uploads it to principal-scoped
 * Supabase Storage (browser never holds the key), records it in the inbound
 * file registry, and attaches a link to the project. Responds 501 when
 * Storage is not configured on the box.
 *
 * Optional form field `kind` — `file` (default), `sample` (a template to
 * match) or `reference` (a reference to read) — names the link kind.
 *
 * An `Idempotency-Key` header makes a retry safe: while the first attempt is
 * in flight, or for a while after it succeeded, the same key from the same
 * principal and project replays that answer instead of storing the bytes a
 * second time.
 *
 * Memory and limits as `/api/chat/upload`: `formData()` buffers the body,
 * the bytes then stream to Storage; the limit is Settings → Uploads. Not
 * matched by the middleware (`lib/http/body-route-guard.ts`), so the handler
 * runs `guardBodyRoute` first.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hashingStream } from "@/lib/chat/hashing-stream";
import { INVALID_FORM_DETAIL } from "@/lib/chat/upload-error";
import { logUploadFailure, type UploadFailureInfo } from "@/lib/chat/upload-log";
import { MULTIPART_SLACK_BYTES, uploadPolicy, uploadRefusal } from "@/lib/chat/upload-space";
import { mediaBucket } from "@/lib/env";
import { guardBodyRoute } from "@/lib/http/body-route-guard";
import { storageAvailable, uploadChatMediaStream } from "@/lib/supabase/storage";
import { invalidRequest, withPrincipal } from "../../../hermes-bridge";

const UPLOAD_LINK_KINDS = new Set(["file", "sample", "reference"]);

const REPLAY_TTL_MS = 10 * 60 * 1000;
const REPLAY_MAX = 500;

interface Replay {
  at: number;
  answer: Promise<{ status: number; body: unknown }>;
}

/** Per-process replay of recent uploads, keyed by principal + slug + key. */
const replays = new Map<string, Replay>();

function pruneReplays(now: number) {
  for (const [key, entry] of replays) {
    if (now - entry.at > REPLAY_TTL_MS) replays.delete(key);
  }
  while (replays.size > REPLAY_MAX) {
    const oldest = replays.keys().next().value;
    if (oldest === undefined) break;
    replays.delete(oldest);
  }
}

/**
 * Uploads this process handles at once; the rest wait their turn. Each one
 * holds several database connections in turn and the pool is small, so a
 * burst (100+ files, several tabs) must queue here instead of failing.
 */
export const MAX_CONCURRENT_UPLOADS = 4;
let activeUploads = 0;
const uploadWaiters: (() => void)[] = [];

async function withUploadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    // A finishing upload hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => uploadWaiters.push(resolve));
  } else {
    activeUploads += 1;
  }
  try {
    return await run();
  } finally {
    const next = uploadWaiters.shift();
    if (next) next();
    else activeUploads -= 1;
  }
}

/** Test seam: forget every remembered upload. */
export function __resetUploadReplays() {
  replays.clear();
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const denied = await guardBodyRoute(request);
  if (denied) return denied;
  const info: UploadFailureInfo = {};
  const res = await upload(request, ctx, info);
  await logUploadFailure("/api/projects/[slug]/files/upload", request, res, info);
  return res;
}

async function upload(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
  info: UploadFailureInfo,
): Promise<NextResponse> {
  const { slug } = await params;
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

  const idemKey = request.headers.get("idempotency-key")?.trim();
  if (!idemKey) return withUploadSlot(() => handleUpload(request, principal, slug, info));

  const replayKey = `${principal.user_id}\u0000${slug}\u0000${idemKey}`;
  const now = Date.now();
  pruneReplays(now);
  const existing = replays.get(replayKey);
  if (existing) {
    const { status, body } = await existing.answer;
    return NextResponse.json(body, { status });
  }
  const answer = withUploadSlot(() => handleUpload(request, principal, slug, info)).then(async (res) => ({
    status: res.status,
    body: await res.clone().json().catch(() => ({})),
  }));
  replays.set(replayKey, { at: now, answer });
  const { status, body } = await answer;
  // Only a success is replayed; a failure must be retryable for real.
  if (status < 200 || status >= 300) replays.delete(replayKey);
  return NextResponse.json(body, { status });
}

async function handleUpload(
  request: Request,
  principal: NonNullable<Awaited<ReturnType<typeof getPrincipal>>>,
  slug: string,
  info: UploadFailureInfo,
): Promise<NextResponse> {
  // Refuse before reading the body: formData() buffers the whole upload.
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
  const file = form.get("file");
  if (!(file instanceof File)) {
    return invalidRequest("A file field is required.");
  }
  info.fileSize = file.size;
  info.fileType = file.type;
  const refused = uploadRefusal(file.size, policy);
  if (refused) return refused;

  const kind = String(form.get("kind") ?? "file").trim() || "file";
  if (!UPLOAD_LINK_KINDS.has(kind)) {
    return invalidRequest("kind must be file, sample or reference.");
  }

  const label =
    (form.get("label") as string | null)?.trim() || file.name || undefined;

  try {
    const hashed = hashingStream(file.stream());
    const stored = await uploadChatMediaStream(principal, slug, {
      name: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      body: hashed.stream,
    });
    const attachment = { ...stored, size: file.size };
    const sha256 = hashed.digest();

    // Register + link under the bridged principal — best-effort registration
    // (the bytes are already in the bucket), but the link must succeed or the
    // upload is orphaned, so it runs inside `withPrincipal` which surfaces
    // upstream errors.
    const client = await apiClientForRequest();
    try {
      await client.registerFile({
        filename: attachment.name,
        content_type: attachment.content_type,
        byte_size: attachment.size,
        sha256,
        storage_bucket: mediaBucket(),
        storage_path: attachment.path,
        conversation: slug,
      });
    } catch {
      // Registry row is repairable by the backfill; the link is not.
    }
    return withPrincipal(async (linkClient) =>
      linkClient.linkToProject(slug, {
        kind,
        ref: attachment.path,
        label,
      }),
    );
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
