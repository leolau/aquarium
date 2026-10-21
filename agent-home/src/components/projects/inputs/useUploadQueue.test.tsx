// @vitest-environment jsdom
/**
 * The upload queue's promises: one upload per file ever — a second drop of
 * the same file is ignored, a double retry sends once, a finished file is
 * never re-sent — and a failed file retries with the same idempotency key.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UploadFn } from "@/components/projects/inputs/uploadProjectFile";
import { MAX_PARALLEL_UPLOADS, useUploadQueue } from "@/components/projects/inputs/useUploadQueue";

function file(name: string, lastModified = 1): File {
  return new File(["abc"], name, { lastModified });
}

function deferredUpload() {
  const pending: { resolve: (ok: boolean) => void; name: string }[] = [];
  const upload = vi.fn<UploadFn>(
    (req) =>
      new Promise((resolve) => {
        pending.push({
          name: req.file.name,
          resolve: (ok) =>
            resolve(
              ok
                ? {
                    ok: true,
                    status: 200,
                    data: { kind: req.kind, ref: `p/${req.file.name}`, profile: "default", label: req.file.name },
                    error: null,
                  }
                : { ok: false, status: 502, data: null, error: "Storage is down." },
            ),
        });
      }),
  );
  return { upload, pending };
}

describe("useUploadQueue", () => {
  it("ignores the same file added twice", () => {
    const { result } = renderHook(() => useUploadQueue({ upload: vi.fn<UploadFn>() }));
    act(() => {
      result.current.add([file("a.pdf"), file("b.pdf")]);
    });
    let added: unknown[] = [];
    act(() => {
      added = result.current.add([file("a.pdf"), file("b.pdf")]);
    });
    expect(added).toHaveLength(0);
    expect(result.current.items.map((i) => i.file.name)).toEqual(["a.pdf", "b.pdf"]);
    // A different file with the same name is a different file.
    act(() => {
      result.current.add([file("a.pdf", 2)]);
    });
    expect(result.current.items).toHaveLength(3);
  });

  it("waits for uploadPending without a slug, then uploads each file once with its role's kind", async () => {
    const { upload, pending } = deferredUpload();
    const { result } = renderHook(() => useUploadQueue({ upload }));
    act(() => {
      result.current.add([file("tpl.docx"), file("ref.pdf")]);
    });
    expect(upload).not.toHaveBeenCalled();
    act(() => result.current.setRole(result.current.items[0].id, "template"));

    let all!: Promise<boolean>;
    let again!: Promise<boolean>;
    act(() => {
      all = result.current.uploadPending("proj");
      again = result.current.uploadPending("proj");
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([r]) => r.kind)).toEqual(["sample", "reference"]);
    expect(result.current.uploading).toBe(true);
    // Role is locked once the upload started.
    act(() => result.current.setRole(result.current.items[0].id, "reference"));
    expect(result.current.items[0].role).toBe("template");

    await act(async () => {
      pending.forEach((p) => p.resolve(true));
      await all;
      await again;
    });
    expect(result.current.items.every((i) => i.status === "done")).toBe(true);
    await act(async () => {
      expect(await result.current.uploadPending("proj")).toBe(true);
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("sends at most MAX_PARALLEL_UPLOADS at once; the rest wait their turn", async () => {
    const { upload, pending } = deferredUpload();
    const { result } = renderHook(() => useUploadQueue({ upload }));
    const names = ["1", "2", "3", "4", "5"].map((n) => `${n}.pdf`);
    act(() => {
      result.current.add(names.map((n) => file(n)));
    });
    let all!: Promise<boolean>;
    act(() => {
      all = result.current.uploadPending("proj");
    });
    expect(upload).toHaveBeenCalledTimes(MAX_PARALLEL_UPLOADS);
    expect(result.current.items.map((i) => Boolean(i.waiting))).toEqual([false, false, false, true, true]);
    // Waiting files are locked like uploading ones.
    act(() => result.current.remove(result.current.items[4].id));
    expect(result.current.items).toHaveLength(5);

    await act(async () => {
      pending[0].resolve(true);
    });
    expect(upload).toHaveBeenCalledTimes(4);
    expect(result.current.items[3].waiting).toBe(false);

    await act(async () => {
      for (let i = 1; i < names.length; i++) {
        await Promise.resolve();
        pending[i]?.resolve(true);
      }
    });
    await act(async () => {
      pending[4]?.resolve(true);
      expect(await all).toBe(true);
    });
    expect(upload).toHaveBeenCalledTimes(5);
    expect(upload.mock.calls.map(([r]) => r.file.name)).toEqual(names);
    expect(result.current.items.every((i) => i.status === "done")).toBe(true);
  });

  it("a failure keeps the row with its error; retry re-sends the same key once", async () => {
    const { upload, pending } = deferredUpload();
    const { result } = renderHook(() => useUploadQueue({ upload }));
    act(() => {
      result.current.add([file("a.pdf")]);
    });
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.uploadPending("proj");
    });
    await act(async () => {
      pending[0].resolve(false);
      expect(await first).toBe(false);
    });
    const item = result.current.items[0];
    expect(item.status).toBe("failed");
    expect(item.error).toBe("Storage is down.");
    expect(result.current.failedCount).toBe(1);

    let r1!: Promise<boolean>;
    act(() => {
      r1 = result.current.retry(item.id, "proj");
      void result.current.retry(item.id, "proj");
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0].idempotencyKey).toBe(upload.mock.calls[0][0].idempotencyKey);
    await act(async () => {
      pending[1].resolve(true);
      expect(await r1).toBe(true);
    });
    expect(result.current.items[0].status).toBe("done");
    expect(result.current.failedCount).toBe(0);
  });

  it("with autoUploadSlug uploads on add, reports the link and (dropDone) clears the row", async () => {
    const { upload, pending } = deferredUpload();
    const onUploaded = vi.fn();
    const { result } = renderHook(() =>
      useUploadQueue({ upload, autoUploadSlug: "proj", onUploaded, dropDone: true }),
    );
    act(() => {
      result.current.add([file("a.pdf")], "template");
      result.current.add([file("a.pdf")], "template");
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toMatchObject({ slug: "proj", kind: "sample" });
    await act(async () => {
      pending[0].resolve(true);
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded.mock.calls[0][0]).toMatchObject({ kind: "sample", ref: "p/a.pdf" });
    expect(result.current.items).toHaveLength(0);
  });

  it("remove drops a queued or failed file but never one uploading", () => {
    const { upload } = deferredUpload();
    const { result } = renderHook(() => useUploadQueue({ upload }));
    act(() => {
      result.current.add([file("a.pdf"), file("b.pdf")]);
    });
    act(() => result.current.remove(result.current.items[0].id));
    expect(result.current.items.map((i) => i.file.name)).toEqual(["b.pdf"]);
    act(() => {
      void result.current.uploadPending("proj");
    });
    act(() => result.current.remove(result.current.items[0].id));
    expect(result.current.items).toHaveLength(1);
  });
});
