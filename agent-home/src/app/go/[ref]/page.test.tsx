/** `/go/<ref>` redirects to the item the ref names, else not-found (FG-36). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";

const resolveRef = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

vi.mock("@/lib/auth/principal", () => ({
  requirePrincipal: async () => ({ userId: "leo" }),
  apiClientForRequest: async () => ({ resolveRef }),
}));

import Page from "./page";

const go = (ref: string) => Page({ params: Promise.resolve({ ref }) });

afterEach(() => {
  resolveRef.mockReset();
});

describe("/go/[ref]", () => {
  it("redirects to the resolved agent-home page", async () => {
    resolveRef.mockResolvedValue({ url: "/projects/digest/runs/3" });
    await expect(go("p12-r3")).rejects.toThrow("NEXT_REDIRECT /projects/digest/runs/3");
    expect(resolveRef).toHaveBeenCalledWith("P12-R3");
  });

  it("opens a to-do and an inbox message", async () => {
    resolveRef.mockResolvedValueOnce({ url: "/todos/0f0e" });
    await expect(go("d88")).rejects.toThrow("NEXT_REDIRECT /todos/0f0e");
    expect(resolveRef).toHaveBeenLastCalledWith("D88");
    resolveRef.mockResolvedValueOnce({ url: "/inbox/1a2b" });
    await expect(go("M512")).rejects.toThrow("NEXT_REDIRECT /inbox/1a2b");
    expect(resolveRef).toHaveBeenLastCalledWith("M512");
  });

  it("is not-found when the ref is hidden or unknown", async () => {
    resolveRef.mockRejectedValue(new HermesApiError(404, "GET /api/refs/T9", { detail: "ref not found" }));
    await expect(go("T9")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not-found for text that is not a ref", async () => {
    await expect(go("digest")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it("never redirects off-site", async () => {
    resolveRef.mockResolvedValue({ url: "//evil.example/x" });
    await expect(go("P1")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
