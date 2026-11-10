/**
 * BFF route tests for the short-ref resolver (FG-36): principal gate, the
 * canonical ref forwarded upstream, and the upstream 404 passed through so
 * a hidden item is indistinguishable from a missing one.
 */
import { describe, expect, it, vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";

const principalState: { principal: unknown } = { principal: { user_id: "leo" } };
const clientState: { client: unknown } = { client: null };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: async () => principalState.principal,
  apiClientForRequest: async () => clientState.client,
}));

import { GET } from "./route";

function call(ref: string) {
  return GET(new Request(`http://x/api/refs/${ref}`), { params: Promise.resolve({ ref }) });
}

describe("GET /api/refs/:ref", () => {
  it("answers 401 without a session", async () => {
    principalState.principal = null;
    expect((await call("P12")).status).toBe(401);
  });

  it("resolves the canonical ref upstream", async () => {
    principalState.principal = { user_id: "leo" };
    const resolveRef = vi.fn(async (ref: string) => ({ ref, kind: "project", url: "/projects/digest" }));
    clientState.client = { resolveRef };
    const res = await call("p12");
    expect(res.status).toBe(200);
    expect(resolveRef).toHaveBeenCalledWith("P12");
    expect(await res.json()).toMatchObject({ ref: "P12", url: "/projects/digest" });
  });

  it("passes the upstream 404 through", async () => {
    principalState.principal = { user_id: "leo" };
    clientState.client = {
      resolveRef: async () => {
        throw new HermesApiError(404, "GET /api/refs/T9", { detail: "ref not found" });
      },
    };
    const res = await call("T9");
    expect(res.status).toBe(404);
  });

  it("answers 404 for text that is not a ref, without calling upstream", async () => {
    principalState.principal = { user_id: "leo" };
    const resolveRef = vi.fn();
    clientState.client = { resolveRef };
    expect((await call("P012")).status).toBe(404);
    expect(resolveRef).not.toHaveBeenCalled();
  });
});
