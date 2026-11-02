/**
 * Server-side Supabase Storage for `agent-home` chat media (FG-20 Wave C1).
 *
 * The browser never holds a storage key: media is uploaded through the
 * `agent-home` BFF, which writes to a **principal-scoped** object path
 * (`<user_id>/<session>/<uuid>-<name>`) so one user's uploads can never collide
 * with or overwrite another's, and returns only that object `path`.
 *
 * The bucket is **private** (FG-20 multi-user PR-5): there are no public URLs.
 * Reads are served by the BFF read route, which resolves the caller's C1
 * principal, verifies the object lives under that principal's own prefix
 * ({@link canReadMediaPath}) and only then mints a short-lived signed URL
 * ({@link createMediaSignedUrl}). Without the ownership check, signing would let
 * any member read any member's object — the check *is* the isolation.
 *
 * The feature degrades gracefully: when no storage key is configured on the
 * box (`storageConfigured()` is false) the upload route reports "not
 * configured" and the composer hides the attach affordance.
 */
import "server-only";

import { createClient } from "@supabase/supabase-js";

import {
  mediaBucket,
  mediaSignedUrlTtlSeconds,
  storageConfigured,
  supabaseStorageKey,
  supabaseUrl,
} from "@/lib/env";
import type { ChatAttachment, Principal } from "@/types";

/** A safe object-path segment (no traversal, no separators). */
export function slug(input: string): string {
  return (
    input
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      // Collapse dot-runs so no segment can look like a `..` traversal.
      .replace(/\.{2,}/g, "_")
      .replace(/^[._]+|[._]+$/g, "") || "file"
  );
}

/**
 * Build the principal-scoped Storage object key
 * (`<user_id>/<session>/<uuid>-<name>`). Every segment is slugged so a crafted
 * user id, session id, or filename can never introduce `/` or `..` traversal
 * out of the principal's prefix.
 */
export function scopedMediaPath(
  principal: Principal,
  sessionId: string,
  fileName: string,
  unique: string,
): string {
  return `${slug(principal.user_id)}/${slug(sessionId || "new")}/${slug(unique)}-${slug(fileName)}`;
}

/**
 * Upload one file to principal-scoped Storage and return its reference. The
 * object key is prefixed with the principal's `user_id` so Storage-level
 * ownership matches the C1 principal. Throws when storage is not configured —
 * callers should check {@link storageAvailable} first.
 */
export async function uploadChatMedia(
  principal: Principal,
  sessionId: string,
  file: { name: string; contentType: string; bytes: ArrayBuffer },
): Promise<ChatAttachment> {
  const key = supabaseStorageKey();
  if (!key) {
    throw new Error("agent-home: Supabase Storage is not configured.");
  }
  const bucket = mediaBucket();
  const client = createClient(supabaseUrl(), key, {
    auth: { persistSession: false },
  });

  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}`;
  const path = scopedMediaPath(principal, sessionId, file.name, unique);

  const { error } = await client.storage
    .from(bucket)
    .upload(path, file.bytes, { contentType: file.contentType, upsert: false });
  if (error) {
    throw new Error(`agent-home: media upload failed — ${error.message}`);
  }

  return {
    path,
    name: file.name,
    content_type: file.contentType,
    size: file.bytes.byteLength,
  };
}

/**
 * Streaming variant of {@link uploadChatMedia} for files too large to buffer
 * in memory (Folder Bridge imports of any size). The body is piped straight
 * to Storage with `duplex: 'half'` — zero buffering in the BFF. The caller
 * is responsible for computing the SHA-256 (typically via a TransformStream
 * that tees the stream) since this function does not see the bytes.
 */
export async function uploadChatMediaStream(
  principal: Principal,
  sessionId: string,
  file: { name: string; contentType: string; body: ReadableStream<Uint8Array> },
): Promise<{ path: string; name: string; content_type: string }> {
  const key = supabaseStorageKey();
  if (!key) {
    throw new Error("agent-home: Supabase Storage is not configured.");
  }
  const bucket = mediaBucket();
  const client = createClient(supabaseUrl(), key, {
    auth: { persistSession: false },
  });

  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}`;
  const path = scopedMediaPath(principal, sessionId, file.name, unique);

  const { error } = await client.storage
    .from(bucket)
    .upload(path, file.body, {
      contentType: file.contentType,
      duplex: "half",
      upsert: false,
    });
  if (error) {
    throw new Error(`agent-home: media upload failed — ${error.message}`);
  }

  return { path, name: file.name, content_type: file.contentType };
}

/**
 * Delete one of the principal's own media objects (an attachment that was
 * uploaded but never sent). Refuses any path outside the principal's prefix.
 */
export async function removeChatMedia(principal: Principal, path: string): Promise<boolean> {
  if (!canReadMediaPath(principal, path)) return false;
  const key = supabaseStorageKey();
  if (!key) {
    throw new Error("agent-home: Supabase Storage is not configured.");
  }
  const client = createClient(supabaseUrl(), key, {
    auth: { persistSession: false },
  });
  const { error } = await client.storage.from(mediaBucket()).remove([path]);
  if (error) {
    throw new Error(`agent-home: media delete failed — ${error.message}`);
  }
  return true;
}

/**
 * Whether `path` is an object key this principal may read.
 *
 * Fail-closed: the path must be a plain, relative, two-or-more-segment key
 * whose **first segment equals `slug(principal.user_id)`** — the same prefix
 * {@link scopedMediaPath} writes. Nothing else is accepted: no absolute paths,
 * no `..` traversal, no backslashes, no empty or dot segments, no encoded
 * separators. Owners/admins are NOT granted cross-user reads (see PR-5: the
 * fail-closed default is own-only for every role, matching the C2 model where
 * another principal's media is simply not visible).
 */
export function canReadMediaPath(principal: Principal, path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.includes("\\") || path.includes("\0") || path.includes("%")) return false;
  if (path.startsWith("/") || path.includes("//")) return false;
  const segments = path.split("/");
  if (segments.length < 2) return false;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return false;
    if (segment.includes("..")) return false;
    // Every segment written by `scopedMediaPath` is slugged; anything else is
    // a crafted key.
    if (segment !== slug(segment)) return false;
  }
  return segments[0] === slug(principal.user_id);
}

/**
 * Mint a short-lived signed URL for a private-bucket object. Callers MUST have
 * passed {@link canReadMediaPath} first — this function does not authorize.
 * Returns null when Storage cannot sign the path (missing object, bad bucket),
 * which the read route maps to 404.
 */
export async function createMediaSignedUrl(
  path: string,
  ttlSeconds: number = mediaSignedUrlTtlSeconds(),
): Promise<{ url: string; expires_in: number } | null> {
  const key = supabaseStorageKey();
  if (!key) {
    throw new Error("agent-home: Supabase Storage is not configured.");
  }
  const client = createClient(supabaseUrl(), key, {
    auth: { persistSession: false },
  });
  const { data, error } = await client.storage
    .from(mediaBucket())
    .createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) return null;
  return { url: data.signedUrl, expires_in: ttlSeconds };
}

/** Whether the box is configured to accept chat-media uploads. */
export function storageAvailable(): boolean {
  return storageConfigured();
}
