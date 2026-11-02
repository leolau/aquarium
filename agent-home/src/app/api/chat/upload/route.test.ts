/**
 * BFF route tests for POST/DELETE /api/chat/upload.
 *
 * The limit comes from Settings → Uploads (served with the storage probe,
 * default 1 GB); `AGENT_HOME_UPLOAD_MAX_BYTES` is the legacy override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, POST } from "@/app/api/chat/upload/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const uploadChatMediaStream = vi.fn(
  async (
    _principal: Principal,
    sessionId: string,
    file: { name: string; contentType: string; body: ReadableStream<Uint8Array> },
  ) => {
    await new Response(file.body).arrayBuffer();
    return {
      path: `mia/${sessionId || "new"}/${file.name}`,
      name: file.name,
      content_type: file.contentType,
    };
  },
);
const removeChatMedia = vi.fn(async (_p: Principal, path: string) => path.startsWith("mia/"));
const registerFile = vi.fn<(payload: { sha256: string }) => Promise<{ ok: boolean }>>(
  async () => ({ ok: true }),
);
const uploadStorage = vi.fn<
  () => Promise<{ free_bytes: number | null; max_bytes?: number | null }>
>(async () => ({ free_bytes: null }));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ registerFile, uploadStorage }),
}));
vi.mock("@/lib/env", () => ({ mediaBucket: () => "hermes-media" }));
vi.mock("@/lib/supabase/storage", () => ({
  storageAvailable: () => true,
  uploadChatMediaStream: (...args: unknown[]) =>
    (uploadChatMediaStream as (...a: unknown[]) => unknown)(...args),
  removeChatMedia: (...args: unknown[]) =>
    (removeChatMedia as (...a: unknown[]) => unknown)(...args),
}));

const principal: Principal = {
  user_id: "mia",
  display: "Mia",
  role: "member",
  channels: [],
  is_owner: false,
};

const URL_ = "http://home.test/api/chat/upload";

function post(file: File, headers: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  form.set("sessionId", "s1");
  return POST(new Request(URL_, { method: "POST", body: form, headers })) as unknown as Promise<Response>;
}

let warn: ReturnType<typeof vi.spyOn>;

describe("POST /api/chat/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    getPrincipal.mockResolvedValue(principal);
    uploadStorage.mockResolvedValue({ free_bytes: null });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("uploads a sub-1 MB file and registers its SHA-256", async () => {
    const bytes = new Uint8Array(300 * 1024).fill(7);
    const res = await post(new File([bytes], "shot.png", { type: "image/png" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "mia/s1/shot.png",
      name: "shot.png",
      content_type: "image/png",
      size: bytes.byteLength,
    });
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    expect(registerFile).toHaveBeenCalledWith(expect.objectContaining({ sha256: digest }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post(new File([new Uint8Array(8)], "a.txt"));
    expect(res.status).toBe(401);
  });

  it("refuses a request from a local app page before reading the body (FG-33 guard, off the middleware)", async () => {
    const res = await post(new File([new Uint8Array(8)], "a.txt"), {
      host: "home.test",
      referer: "http://home.test/apps/notes/",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(403);
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
  });

  it("refuses a file above the configured limit with 413", async () => {
    uploadStorage.mockResolvedValue({ free_bytes: null, max_bytes: 1024 * 1024 });
    const res = await post(new File([new Uint8Array(1024 * 1024 + 1)], "big.bin"));
    expect(res.status).toBe(413);
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
    expect(((await res.json()) as { detail: string }).detail).toMatch(/1 MB upload limit/);
  });

  it("defaults to a 1 GB limit (refused from Content-Length, body unread)", async () => {
    const formData = vi.fn();
    const req = new Request(URL_, {
      method: "POST",
      headers: { "content-length": String(1024 ** 3 + 1024 * 1024) },
    });
    Object.defineProperty(req, "formData", { value: formData });
    const res = (await POST(req)) as unknown as Response;
    expect(res.status).toBe(413);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/1 GB upload limit/);
    expect(formData).not.toHaveBeenCalled();
  });

  it("lets the legacy env override win over the saved limit", async () => {
    vi.stubEnv("AGENT_HOME_UPLOAD_MAX_BYTES", "100");
    uploadStorage.mockResolvedValue({ free_bytes: null, max_bytes: 1024 ** 3 });
    const res = await post(new File([new Uint8Array(101)], "a.bin"));
    expect(res.status).toBe(413);
  });

  it("accepts a file above the old 10 MB middleware cap", async () => {
    const res = await post(new File([new Uint8Array(11 * 1024 * 1024)], "big.bin"));
    expect(res.status).toBe(200);
    expect(uploadChatMediaStream).toHaveBeenCalledOnce();
  });

  it("answers an unreadable body with invalid_form and a human detail, and logs it", async () => {
    const res = (await POST(
      new Request(URL_, {
        method: "POST",
        body: "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\nabc",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      }),
    )) as unknown as Response;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("invalid_form");
    expect(body.detail).toMatch(/incomplete or malformed/);
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/status=400 error=invalid_form/);
    expect(line).toMatch(/content_type=multipart\/form-data /);
    expect(line).not.toMatch(/boundary|abc/);
  });

  it("returns 502 with the storage error when the upload to Storage fails", async () => {
    uploadChatMediaStream.mockRejectedValueOnce(new Error("agent-home: media upload failed — boom"));
    const res = await post(new File([new Uint8Array(512)], "a.png", { type: "image/png" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "upload_failed",
      detail: "agent-home: media upload failed — boom",
    });
    expect(String(warn.mock.calls[0][0])).toMatch(
      /status=502 error=upload_failed .*file_size=512 file_type=image\/png/,
    );
  });

  it("still succeeds when registry registration fails (best effort)", async () => {
    registerFile.mockRejectedValueOnce(new Error("registry down"));
    const res = await post(new File([new Uint8Array(512)], "a.png"));
    expect(res.status).toBe(200);
  });

  it("refuses a file bigger than the free upload disk space with 507, in plain words", async () => {
    uploadStorage.mockResolvedValue({ free_bytes: 1024 });
    const res = await post(new File([new Uint8Array(4096)], "big.bin"));
    expect(res.status).toBe(507);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("insufficient_storage");
    expect(body.detail).toMatch(/Not enough storage space/);
    expect(uploadChatMediaStream).not.toHaveBeenCalled();
  });

  it("uploads when the storage probe cannot be read (never blocks a working box)", async () => {
    uploadStorage.mockRejectedValue(new Error("backend down"));
    const res = await post(new File([new Uint8Array(4096)], "ok.bin"));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/chat/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal);
  });

  const del = (body: unknown) =>
    DELETE(
      new Request(URL_, { method: "DELETE", body: JSON.stringify(body) }),
    ) as unknown as Promise<Response>;

  it("deletes the caller's own object", async () => {
    const res = await del({ path: "mia/s1/a.png" });
    expect(res.status).toBe(200);
    expect(removeChatMedia).toHaveBeenCalledWith(principal, "mia/s1/a.png");
  });

  it("does not delete another principal's object", async () => {
    expect((await del({ path: "bob/s1/a.png" })).status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await del({ path: "mia/s1/a.png" })).status).toBe(401);
    expect(removeChatMedia).not.toHaveBeenCalled();
  });
});
