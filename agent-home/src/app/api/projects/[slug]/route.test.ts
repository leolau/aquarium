/**
 * BFF route tests for the hard delete (decision 17): principal gate,
 * the typed `confirm` forwarded to upstream, and upstream refusals
 * passed through so the dialog can say *why*.
 */
import { describe, expect, it, vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";

const principalState: { principal: unknown } = { principal: { user_id: "leo" } };
const clientState: { client: unknown } = { client: null };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: async () => principalState.principal,
  apiClientForRequest: async () => clientState.client,
}));

import { DELETE } from "./route";

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function req(confirm: string, extra = ""): Request {
  return new Request(
    `http://x/api/projects/digest?confirm=${encodeURIComponent(confirm)}${extra}`,
    { method: "DELETE" },
  );
}

describe("DELETE /api/projects/:slug", () => {
  it("answers 401 without a session", async () => {
    principalState.principal = null;
    const res = await DELETE(req("digest"), params("digest"));
    expect(res.status).toBe(401);
  });

  it("forwards the typed confirm and the upstream refusal together", async () => {
    principalState.principal = { user_id: "leo" };
    const calls: Array<[string, string]> = [];
    clientState.client = {
      deleteProject: async (slug: string, confirm: string) => {
        calls.push([slug, confirm]);
        throw new HermesApiError(409, "DELETE", {
          detail: "refused: 1 run, 1 card",
        });
      },
    };
    const res = await DELETE(req("digest"), params("digest"));
    expect(res.status).toBe(409);
    expect(calls).toEqual([["digest", "digest"]]);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe("refused: 1 run, 1 card");
  });

  it("answers with the deleted slug on success", async () => {
    principalState.principal = { user_id: "leo" };
    clientState.client = {
      deleteProject: async () => ({ deleted: "digest" }),
    };
    const res = await DELETE(req("digest"), params("digest"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "digest" });
  });

  it("forwards purge=smoke and passes the purge summary through", async () => {
    principalState.principal = { user_id: "leo" };
    const calls: unknown[][] = [];
    const purged = { deleted: "digest", purged: { runs: 1, cards: 2, sessions: 1 } };
    clientState.client = {
      deleteProject: async (...args: unknown[]) => {
        calls.push(args);
        return purged;
      },
    };
    const res = await DELETE(req("digest", "&purge=smoke"), params("digest"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([["digest", "digest", { purge: "smoke" }]]);
    expect(await res.json()).toEqual(purged);
  });

  it("passes an upstream purge refusal through", async () => {
    principalState.principal = { user_id: "leo" };
    clientState.client = {
      deleteProject: async () => {
        throw new HermesApiError(403, "DELETE", {
          detail: "purge is only for [smoke] test projects",
        });
      },
    };
    const res = await DELETE(req("digest", "&purge=smoke"), params("digest"));
    expect(res.status).toBe(403);
  });
});
