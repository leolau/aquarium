/**
 * BFF route tests for POST /api/projects/:slug/files/upload: the link kind a
 * file's role maps to, and an Idempotency-Key that makes a retry replay the
 * first answer instead of storing the bytes twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const uploadChatMedia = vi.fn(
  async (
    _principal: Principal,
    sessionId: string,
    file: { name: string; contentType: string; bytes: ArrayBuffer },
  ) => ({
    path: `leo/${sessionId}/${uploadChatMedia.mock.calls.length}-${file.name}`,
    name: file.name,
    content_type: file.contentType,
    size: file.bytes.byteLength,
  }),
);
const registerFile = vi.fn(async () => ({ ok: true }));
const linkToProject = vi.fn(async (_slug: string, payload: Record<string, unknown>) => ({
  ...payload,
  profile: "default",
}));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ registerFile, linkToProject }),
}));
vi.mock("@/lib/env", () => ({ mediaBucket: () => "hermes-media" }));
vi.mock("@/lib/supabase/storage", () => ({
  storageAvailable: () => true,
  uploadChatMedia: (...args: unknown[]) =>
    (uploadChatMedia as (...a: unknown[]) => unknown)(...args),
}));

import { MAX_CONCURRENT_UPLOADS, POST, __resetUploadReplays } from "./route";

const principal: Principal = {
  user_id: "leo",
  display: "Leo",
  role: "member",
  channels: [],
  is_owner: false,
};

function post(opts: { kind?: string; key?: string; name?: string } = {}): Promise<Response> {
  const form = new FormData();
  form.set("file", new File(["hello"], opts.name ?? "MOU.docx", { type: "text/plain" }));
  if (opts.kind) form.set("kind", opts.kind);
  const headers: Record<string, string> = {};
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  return POST(
    new Request("http://home.test/api/projects/mou/files/upload", {
      method: "POST",
      body: form,
      headers,
    }),
    { params: Promise.resolve({ slug: "mou" }) },
  ) as unknown as Promise<Response>;
}

describe("POST /api/projects/:slug/files/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUploadReplays();
    getPrincipal.mockResolvedValue(principal);
  });

  it("answers 401 without a session", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(401);
    expect(uploadChatMedia).not.toHaveBeenCalled();
  });

  it("links as a plain file by default", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(linkToProject).toHaveBeenCalledWith(
      "mou",
      expect.objectContaining({ kind: "file", label: "MOU.docx" }),
    );
  });

  it.each(["sample", "reference"])("links with kind %s when asked", async (kind) => {
    const res = await post({ kind });
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe(kind);
    expect(linkToProject.mock.calls[0][1]).toMatchObject({ kind });
  });

  it("refuses an unknown kind before storing anything", async () => {
    const res = await post({ kind: "memory" });
    expect(res.status).toBe(400);
    expect(uploadChatMedia).not.toHaveBeenCalled();
  });

  it("replays a success for the same Idempotency-Key", async () => {
    const first = await post({ key: "k1" });
    const second = await post({ key: "k1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(uploadChatMedia).toHaveBeenCalledTimes(1);
    expect(linkToProject).toHaveBeenCalledTimes(1);
  });

  it("shares one upload between two concurrent requests with the same key", async () => {
    const [a, b] = await Promise.all([post({ key: "k2" }), post({ key: "k2" })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(uploadChatMedia).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failure — the retry really runs", async () => {
    uploadChatMedia.mockRejectedValueOnce(new Error("bucket down"));
    const failed = await post({ key: "k3" });
    expect(failed.status).toBe(502);
    const retried = await post({ key: "k3" });
    expect(retried.status).toBe(200);
    expect(uploadChatMedia).toHaveBeenCalledTimes(2);
  });

  it("handles at most MAX_CONCURRENT_UPLOADS at once; the rest queue, none fail", async () => {
    const gates: (() => void)[] = [];
    const real = uploadChatMedia.getMockImplementation()!;
    uploadChatMedia.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return real(...args);
    });
    const total = MAX_CONCURRENT_UPLOADS + 3;
    const all = Promise.all(
      Array.from({ length: total }, (_, i) => post({ key: `burst-${i}`, name: `f${i}.pdf` })),
    );
    await vi.waitFor(() => expect(gates).toHaveLength(MAX_CONCURRENT_UPLOADS));
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadChatMedia).toHaveBeenCalledTimes(MAX_CONCURRENT_UPLOADS);

    let released = 0;
    while (released < total) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(released));
      gates[released++]();
    }
    const answers = await all;
    expect(answers.map((r) => r.status)).toEqual(Array(total).fill(200));
    expect(uploadChatMedia).toHaveBeenCalledTimes(total);
    uploadChatMedia.mockImplementation(real);
  });

  it("different keys upload separately", async () => {
    await post({ key: "a" });
    await post({ key: "b" });
    expect(uploadChatMedia).toHaveBeenCalledTimes(2);
  });
});
