/**
 * BFF route tests for POST /api/files/import (Folder Bridge import).
 *
 * The contract that matters: the bytes handed to Storage are exactly the
 * bytes posted (binary-safe), the returned sha256 is of those bytes, and the
 * registry row is mandatory (a failed registration is a failed import).
 *
 * The route now streams the raw request body to Storage (no multipart), so
 * tests post the file as the body with metadata in headers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/files/import/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const storageAvailable = vi.fn(() => true);
const uploadChatMediaStream = vi.fn(
  async (
    _principal: Principal,
    sessionId: string,
    file: { name: string; contentType: string; body: ReadableStream<Uint8Array> },
  ) => {
    // Drain the stream so the route's hash TransformStream processes all
    // chunks — otherwise the mock returns before the hash is computed.
    const reader = file.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return {
      path: `mia/${sessionId}/uuid-${file.name}`,
      name: file.name,
      content_type: file.contentType,
    };
  },
);
const registerFile = vi.fn(async (payload: Record<string, unknown>) => ({
  id: "asset-1",
  ...payload,
}));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ registerFile }),
}));
vi.mock("@/lib/env", () => ({ mediaBucket: () => "agent-home-media" }));
vi.mock("@/lib/supabase/storage", () => ({
  storageAvailable: () => storageAvailable(),
  uploadChatMediaStream: (...args: unknown[]) =>
    (uploadChatMediaStream as (...a: unknown[]) => unknown)(...args),
  // Mirror of the real slug() — the module itself can't be imported in tests
  // (it imports `server-only`, which throws outside an RSC build).
  slug: (input: string) =>
    input
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[._]+|[._]+$/g, "") || "file",
}));
vi.mock("@/lib/chat/upload-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/upload-limit")>()),
  resolveUploadMaxBytes: () => 64,
  uploadTooLargeDetail: (n: number) => `File exceeds the ${n} B limit.`,
}));

const principal: Principal = {
  user_id: "mia",
  display: "Mia",
  role: "member",
  channels: [],
  is_owner: false,
};

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0xc3, 0x0a,
]);

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function postRaw(
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers({
    "content-type": "application/octet-stream",
    "x-file-name": "invoice.pdf",
    "x-source-path": "2026/invoice.pdf",
    "x-folder-label": "Invoices",
    "content-length": String(bytes.length),
    ...headers,
  });
  return POST(
    new Request("http://home.test/api/files/import", {
      method: "POST",
      body: bytes.buffer.slice(0) as BodyInit,
      headers: h,
    }),
  ) as unknown as Promise<Response>;
}

describe("POST /api/files/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal);
    storageAvailable.mockReturnValue(true);
  });

  it("401s when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await postRaw(PDF_BYTES);
    expect(res.status).toBe(401);
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
  });

  it("501s when storage is not configured", async () => {
    storageAvailable.mockReturnValue(false);
    const res = await postRaw(PDF_BYTES);
    expect(res.status).toBe(501);
  });

  it("400s without a body", async () => {
    const res = await POST(
      new Request("http://home.test/api/files/import", {
        method: "POST",
        headers: { "x-file-name": "a.pdf" },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_file" });
  });

  it("413s over the size cap", async () => {
    const res = await postRaw(new Uint8Array(65), {
      "content-length": "65",
    });
    expect(res.status).toBe(413);
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
  });

  it("streams the exact bytes, registers the row, and returns the hash", async () => {
    const res = await postRaw(PDF_BYTES, {
      "content-type": "application/pdf",
      "x-file-name": "invoice.pdf",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = await sha256(PDF_BYTES);

    const stored = uploadChatMediaStream.mock.calls[0];
    expect(stored[1]).toBe("folder-bridge");
    expect(stored[2].name).toBe("invoice.pdf");
    expect(stored[2].contentType).toBe("application/pdf");

    expect(registerFile).toHaveBeenCalledWith({
      filename: "invoice.pdf",
      content_type: "application/pdf",
      byte_size: 10,
      sha256: expected,
      storage_bucket: "agent-home-media",
      storage_path: "mia/folder-bridge/uuid-invoice.pdf",
      conversation: "Invoices/2026/invoice.pdf",
    });
    expect(body).toMatchObject({
      asset: { id: "asset-1" },
      sha256: expected,
      size: 10,
      storage_bucket: "agent-home-media",
      storage_path: "mia/folder-bridge/uuid-invoice.pdf",
    });
  });

  it("502s when registration fails (a stored-but-unregistered file is not an import)", async () => {
    registerFile.mockRejectedValueOnce(new Error("registry down"));
    const res = await postRaw(PDF_BYTES);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "import_failed",
      detail: "registry down",
    });
  });
});

describe("POST /api/files/import (chunked)", () => {
  let spoolTmp: string;

  beforeEach(async () => {
    spoolTmp = await mkdtemp(join(tmpdir(), "import-route-test-"));
    vi.stubEnv("TMPDIR", spoolTmp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(spoolTmp, { recursive: true, force: true });
  });

  function postChunk(
    bytes: Uint8Array | null,
    importId: string,
    offset: number,
    total: number,
  ): Promise<Response> {
    return POST(
      new Request("http://home.test/api/files/import", {
        method: "POST",
        body: bytes ? (bytes.buffer.slice(0) as BodyInit) : null,
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": "invoice.pdf",
          "x-source-path": "2026/invoice.pdf",
          "x-folder-label": "Invoices",
          "x-import-id": importId,
          "x-import-offset": String(offset),
          "x-import-total": String(total),
        },
      }),
    ) as unknown as Promise<Response>;
  }

  it("assembles chunks, then finalizes to Storage + registry", async () => {
    const id = "imp-1";
    const half = PDF_BYTES.length / 2;

    const r1 = await postChunk(PDF_BYTES.slice(0, half), id, 0, PDF_BYTES.length);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: half });

    const r2 = await postChunk(
      PDF_BYTES.slice(half),
      id,
      half,
      PDF_BYTES.length,
    );
    expect(await r2.json()).toEqual({ received: PDF_BYTES.length });

    const fin = await postChunk(null, id, PDF_BYTES.length, PDF_BYTES.length);
    expect(fin.status).toBe(200);
    const body = await fin.json();
    expect(body.asset.id).toBe("asset-1");
    expect(body.sha256).toBe(await sha256(PDF_BYTES));
    expect(registerFile).toHaveBeenCalledWith(
      expect.objectContaining({ byte_size: PDF_BYTES.length }),
    );
  });

  it("409s with the true byte count when the client offset is stale", async () => {
    const id = "imp-2";
    await postChunk(PDF_BYTES.slice(0, 4), id, 0, PDF_BYTES.length);
    const res = await postChunk(PDF_BYTES.slice(4), id, 0, PDF_BYTES.length);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "offset_mismatch",
      received: 4,
    });
  });

  it("replays a completed finalize instead of double-registering", async () => {
    const id = "imp-3";
    await postChunk(PDF_BYTES, id, 0, PDF_BYTES.length);
    const fin = await postChunk(null, id, PDF_BYTES.length, PDF_BYTES.length);
    expect(fin.status).toBe(200);

    uploadChatMediaStream.mockClear();
    registerFile.mockClear();
    const retry = await postChunk(null, id, PDF_BYTES.length, PDF_BYTES.length);
    expect(retry.status).toBe(200);
    expect((await retry.json()).asset.id).toBe("asset-1");
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
    expect(registerFile).not.toHaveBeenCalled();
  });

  it("400s bad chunk headers", async () => {
    const res = await POST(
      new Request("http://home.test/api/files/import", {
        method: "POST",
        body: PDF_BYTES.buffer.slice(0) as BodyInit,
        headers: {
          "x-import-id": "imp-bad",
          "x-import-offset": "abc",
          "x-import-total": "10",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_chunk_headers" });
  });
});
