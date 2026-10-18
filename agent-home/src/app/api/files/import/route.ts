/**
 * POST /api/files/import — Folder Bridge import (byte-faithful copy of one
 * local file into the file store).
 *
 * The browser posts the raw `File` as the request body (not multipart) with
 * metadata in headers (`x-file-name`, `x-source-path`, `x-folder-label`).
 * The BFF streams the body through a SHA-256 TransformStream straight to
 * principal-scoped Storage with `duplex: 'half'` — zero buffering, works for
 * any file size — then registers the asset in `file_assets` (surface
 * `agent_home`). The response carries the server-computed SHA-256.
 *
 * Bytes never traverse the app-mcp WebSocket or the model context: the agent
 * only ever sees the registry row.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { uploadMaxBytes, uploadTooLargeDetail } from "@/lib/chat/upload-limit";
import { uploadSpaceRefusal } from "@/lib/chat/upload-space";
import { mediaBucket } from "@/lib/env";
import {
  slug,
  storageAvailable,
  uploadChatMediaStream,
} from "@/lib/supabase/storage";
import type { Principal } from "@/types";

/** Storage "session" segment for bridge imports (`<user>/folder-bridge/<uuid>-<name>`). */
export const IMPORT_SCOPE = "folder-bridge";

/**
 * Chunked import spool. Large files arrive as a sequence of short chunk
 * requests (`x-import-id`/`x-import-offset`/`x-import-total`) appended to a
 * per-principal `.part` file here; a final request at offset == total then
 * streams the assembled file to Storage. Browsers kill any single request
 * that runs long enough (observed: Safari aborts a ~1 GiB POST at ~300 s on
 * every network), so no individual request may carry a whole large file.
 * Abandoned spools are swept after SPOOL_TTL_MS.
 */
const SPOOL_TTL_MS = 24 * 60 * 60 * 1000;

/** Lazy so tests can redirect via TMPDIR before a request is handled. */
function spoolRoot(): string {
  return join(tmpdir(), "agent-home-imports");
}

function spoolPathFor(principal: Principal, importId: string): string {
  return join(spoolRoot(), slug(principal.user_id), `${slug(importId)}.part`);
}

/** Best-effort sweep of abandoned spool/done files older than the TTL. */
async function sweepSpool(): Promise<void> {
  let dirs: string[];
  try {
    dirs = await readdir(spoolRoot());
  } catch {
    return;
  }
  const now = Date.now();
  for (const dir of dirs) {
    const dirPath = join(spoolRoot(), dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dirPath, entry);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > SPOOL_TTL_MS) await rm(p, { force: true });
      } catch {
        // Gone or unreadable — leave it for the next sweep.
      }
    }
  }
}

async function spoolSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

interface ImportMeta {
  fileName: string;
  contentType: string;
  sourcePath: string;
  folderLabel: string;
}

function metaFromHeaders(request: Request): ImportMeta {
  return {
    fileName:
      request.headers.get("x-file-name") != null
        ? decodeURIComponent(request.headers.get("x-file-name")!)
        : "import",
    contentType:
      request.headers.get("content-type") || "application/octet-stream",
    sourcePath: decodeURIComponent(request.headers.get("x-source-path") ?? ""),
    folderLabel: decodeURIComponent(request.headers.get("x-folder-label") ?? ""),
  };
}

function importError(detail: string, status: number, error = "import_failed") {
  return NextResponse.json({ error, detail }, { status });
}

/** Stream `body` through a SHA-256 hash into Storage, then register the asset. */
async function storeAndRegister(
  principal: Principal,
  meta: ImportMeta,
  body: ReadableStream<Uint8Array>,
): Promise<NextResponse> {
  const hasher = createHash("sha256");
  let bytesSeen = 0;
  const hashTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hasher.update(chunk);
      bytesSeen += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const t0 = Date.now();
  const stored = await uploadChatMediaStream(principal, IMPORT_SCOPE, {
    name: meta.fileName,
    contentType: meta.contentType,
    body: body.pipeThrough(hashTransform),
  });
  const storageMs = Date.now() - t0;
  const sha256 = hasher.digest("hex");
  const client = await apiClientForRequest();
  const asset = await client.registerFile({
    filename: stored.name,
    content_type: stored.content_type,
    byte_size: bytesSeen,
    sha256,
    storage_bucket: mediaBucket(),
    storage_path: stored.path,
    conversation:
      meta.folderLabel && meta.sourcePath
        ? `${meta.folderLabel}/${meta.sourcePath}`
        : undefined,
  });
  console.info(
    `import-store user=${principal.user_id} name=${meta.fileName} bytes=${bytesSeen} storage_ms=${storageMs}`,
  );
  return NextResponse.json({
    asset,
    sha256,
    size: bytesSeen,
    storage_bucket: mediaBucket(),
    storage_path: stored.path,
  });
}

/**
 * Chunked path: `x-import-id` + `x-import-offset` + `x-import-total`.
 *
 * Each request with offset < total appends its body to the spool file and
 * returns `{received}` — the authoritative byte count, so a lost response or
 * retry just resyncs (a request whose offset doesn't match `received` gets
 * 409 + `{received}`). A request at offset == total finalizes: stream the
 * assembled file to Storage, register it, and return the asset. Finalize is
 * idempotent — the result is cached in a `.done` marker so a retried
 * finalize can never double-register.
 */
async function handleChunkedImport(
  request: Request,
  principal: Principal,
  meta: ImportMeta,
): Promise<NextResponse> {
  const importId = request.headers.get("x-import-id") ?? "";
  const offset = Number(request.headers.get("x-import-offset"));
  const total = Number(request.headers.get("x-import-total"));
  if (
    !importId ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(total) ||
    offset < 0 ||
    total <= 0
  ) {
    return importError("Invalid chunk headers.", 400, "bad_chunk_headers");
  }
  const maxBytes = uploadMaxBytes();
  if (maxBytes < Infinity && total > maxBytes) {
    return NextResponse.json(
      { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
      { status: 413 },
    );
  }
  if (offset === 0) {
    const noSpace = await uploadSpaceRefusal(total);
    if (noSpace) return noSpace;
  }

  await sweepSpool();
  const spool = spoolPathFor(principal, importId);
  const donePath = spool.replace(/\.part$/, ".done");

  // Idempotent finalize: a retry after a lost response returns the cached
  // result instead of re-uploading and double-registering.
  if (offset === total) {
    try {
      const cached = JSON.parse(await readFile(donePath, "utf8"));
      return NextResponse.json(cached);
    } catch {
      // No marker — fall through to a real finalize (or resync below).
    }
  }

  await mkdir(dirname(spool), { recursive: true });
  const received = await spoolSize(spool);
  if (offset !== received) {
    return NextResponse.json(
      { error: "offset_mismatch", received },
      { status: 409 },
    );
  }

  if (offset < total) {
    if (!request.body) {
      return importError("A request body is required.", 400, "missing_file");
    }
    if (offset === 0) {
      // Fresh import — refuse early if the spool disk can't hold the file.
      try {
        const fs2 = await statfs(spoolRoot());
        if (fs2.bavail * fs2.bsize < total) {
          return importError("Not enough free space to stage this import.", 507);
        }
      } catch {
        // statfs unavailable/failed — proceed and let writes surface ENOSPC.
      }
    }
    const t0 = Date.now();
    try {
      await pipeline(
        Readable.fromWeb(
          request.body as unknown as import("node:stream/web").ReadableStream,
        ),
        createWriteStream(spool, { flags: "a" }),
      );
    } catch (err) {
      return importError(
        err instanceof Error ? err.message : "Chunk write failed.",
        502,
        "chunk_write_failed",
      );
    }
    const now = await spoolSize(spool);
    if (now > total) {
      await rm(spool, { force: true });
      return importError("Chunk exceeds the declared total size.", 400, "chunk_overflow");
    }
    console.info(
      `import-chunk user=${principal.user_id} id=${importId.slice(0, 8)} received=${now} total=${total} ms=${Date.now() - t0}`,
    );
    return NextResponse.json({ received: now });
  }

  // offset === received === total → finalize
  const t0 = Date.now();
  try {
    const res = await storeAndRegister(
      principal,
      meta,
      Readable.toWeb(
        createReadStream(spool),
      ) as unknown as ReadableStream<Uint8Array>,
    );
    const payload = await res.clone().json().catch(() => null);
    if (payload) {
      await writeFile(donePath, JSON.stringify(payload));
    }
    await rm(spool, { force: true });
    console.info(
      `import-finalize user=${principal.user_id} id=${importId.slice(0, 8)} bytes=${total} ms=${Date.now() - t0}`,
    );
    return res;
  } catch (err) {
    return importError(
      err instanceof Error ? err.message : "Import failed.",
      502,
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!storageAvailable()) {
    return NextResponse.json(
      {
        error: "storage_unconfigured",
        detail: "Media storage is not configured.",
      },
      { status: 501 },
    );
  }

  const meta = metaFromHeaders(request);
  if (request.headers.get("x-import-id")) {
    return handleChunkedImport(request, principal, meta);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!request.body) {
    return NextResponse.json(
      { error: "missing_file", detail: "A request body is required." },
      { status: 400 },
    );
  }

  const maxBytes = uploadMaxBytes();
  if (maxBytes < Infinity && contentLength > maxBytes) {
    return NextResponse.json(
      { error: "too_large", detail: uploadTooLargeDetail(maxBytes) },
      { status: 413 },
    );
  }
  const noSpace = await uploadSpaceRefusal(contentLength);
  if (noSpace) return noSpace;

  const t0 = Date.now();
  try {
    return await storeAndRegister(principal, meta, request.body);
  } catch (err) {
    return importError(
      err instanceof Error ? err.message : "Import failed.",
      502,
    );
  } finally {
    console.info(
      `import-request user=${principal.user_id} name=${meta.fileName} content_length=${contentLength} ms=${Date.now() - t0}`,
    );
  }
}
