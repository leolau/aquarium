/**
 * BFF tests for Get ready → Backups: owner only (member/admin get 403 and the
 * Python layer is never called), and Python errors pass through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as actionPOST } from "@/app/api/backups/offsite/[action]/route";
import { DELETE, GET, PUT } from "@/app/api/backups/offsite/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const offsiteBackup = vi.fn();
const configureOffsiteBackup = vi.fn();
const removeOffsiteBackup = vi.fn();
const offsiteBackupAction = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    offsiteBackup,
    configureOffsiteBackup,
    removeOffsiteBackup,
    offsiteBackupAction,
  }),
}));

function who(role: Principal["role"]): Principal {
  return { user_id: role, display: role, role, channels: [], is_owner: role === "owner" };
}

const STATUS = { available: true, configured: false, state: "not_configured" };
const params = (action: string) => ({ params: Promise.resolve({ action }) });
const put = (body: unknown) =>
  new Request("http://x/api/backups/offsite", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(who("owner"));
});

describe("/api/backups/offsite", () => {
  it.each(["admin", "member", "viewer"] as const)("refuses %s on every route", async (role) => {
    getPrincipal.mockResolvedValue(who(role));
    for (const res of [
      await GET(),
      await PUT(put({ provider: "b2" })),
      await DELETE(),
      await actionPOST(new Request("http://x"), params("run")),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(offsiteBackup).not.toHaveBeenCalled();
    expect(configureOffsiteBackup).not.toHaveBeenCalled();
    expect(removeOffsiteBackup).not.toHaveBeenCalled();
    expect(offsiteBackupAction).not.toHaveBeenCalled();
  });

  it("needs a login", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("forwards the owner's status and settings", async () => {
    offsiteBackup.mockResolvedValue(STATUS);
    expect(await (await GET()).json()).toEqual(STATUS);
    configureOffsiteBackup.mockResolvedValue({ status: STATUS, new_key: "k" });
    const res = await PUT(put({ provider: "b2", bucket: "abc", key_id: "id", secret: "s" }));
    expect(res.status).toBe(200);
    expect(configureOffsiteBackup).toHaveBeenCalledWith({ provider: "b2", bucket: "abc", key_id: "id", secret: "s" });
  });

  it("rejects a body that is not an object", async () => {
    expect((await PUT(put("not json"))).status).toBe(400);
    expect((await PUT(put([1, 2]))).status).toBe(400);
    expect(configureOffsiteBackup).not.toHaveBeenCalled();
  });

  it("passes the Python error through", async () => {
    configureOffsiteBackup.mockRejectedValue(new HermesApiError(400, "the bucket was not found"));
    const res = await PUT(put({ provider: "b2" }));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("bucket was not found");
  });

  it("starts jobs with 202 and refuses unknown actions", async () => {
    offsiteBackupAction.mockResolvedValue({ started: true, status: STATUS });
    expect((await actionPOST(new Request("http://x"), params("run"))).status).toBe(202);
    expect((await actionPOST(new Request("http://x"), params("restore-test"))).status).toBe(202);
    offsiteBackupAction.mockResolvedValue(STATUS);
    expect((await actionPOST(new Request("http://x"), params("test"))).status).toBe(200);
    expect((await actionPOST(new Request("http://x"), params("remove"))).status).toBe(404);
    expect(offsiteBackupAction).toHaveBeenCalledTimes(3);
  });
});
