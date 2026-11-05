/**
 * BFF tests for Settings → Software upgrade: owner upgrades, admin reads only,
 * members/viewers/logged-out are refused before Python is called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as checkPOST } from "@/app/api/software-upgrade/check/route";
import { GET as jobGET } from "@/app/api/software-upgrade/job/route";
import { POST as rollbackPOST } from "@/app/api/software-upgrade/rollback/route";
import { GET } from "@/app/api/software-upgrade/route";
import { POST as startPOST } from "@/app/api/software-upgrade/start/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const softwareUpgrade = vi.fn();
const softwareUpgradeJob = vi.fn();
const checkSoftwareUpgrade = vi.fn();
const startSoftwareUpgrade = vi.fn();
const rollbackSoftwareUpgrade = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    softwareUpgrade,
    softwareUpgradeJob,
    checkSoftwareUpgrade,
    startSoftwareUpgrade,
    rollbackSoftwareUpgrade,
  }),
}));

function who(role: Principal["role"]): Principal {
  return { user_id: role, display: role, role, channels: [], is_owner: role === "owner" };
}

const STATUS = { available: true, installed: { version: "v1.0.0" } };
const post = (body: unknown) =>
  new Request("http://x/api/software-upgrade/start", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const allCalls = () => [
  softwareUpgrade,
  softwareUpgradeJob,
  checkSoftwareUpgrade,
  startSoftwareUpgrade,
  rollbackSoftwareUpgrade,
];

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(who("owner"));
  for (const fn of [softwareUpgrade, softwareUpgradeJob, checkSoftwareUpgrade]) fn.mockResolvedValue(STATUS);
  startSoftwareUpgrade.mockResolvedValue({ started: true, status: STATUS });
  rollbackSoftwareUpgrade.mockResolvedValue({ started: true, status: STATUS });
});

describe("/api/software-upgrade", () => {
  it.each(["member", "viewer"] as const)("refuses %s on every route", async (role) => {
    getPrincipal.mockResolvedValue(who(role));
    for (const res of [
      await GET(),
      await jobGET(),
      await checkPOST(),
      await startPOST(post({ version: "v1.1.0", password: "pw" })),
      await rollbackPOST(post({ password: "pw" })),
    ]) {
      expect(res.status).toBe(403);
    }
    for (const fn of allCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it("needs a login on every route", async () => {
    getPrincipal.mockResolvedValue(null);
    for (const res of [
      await GET(),
      await jobGET(),
      await checkPOST(),
      await startPOST(post({ version: "v1.1.0", password: "pw" })),
      await rollbackPOST(post({ password: "pw" })),
    ]) {
      expect(res.status).toBe(401);
    }
    for (const fn of allCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it("lets an admin read and check, read only", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect(await (await GET()).json()).toEqual({ ...STATUS, can_upgrade: false });
    expect((await jobGET()).status).toBe(200);
    expect((await checkPOST()).status).toBe(200);
    expect((await startPOST(post({ version: "v1.1.0", password: "pw" }))).status).toBe(403);
    expect((await rollbackPOST(post({ password: "pw" }))).status).toBe(403);
    expect(startSoftwareUpgrade).not.toHaveBeenCalled();
    expect(rollbackSoftwareUpgrade).not.toHaveBeenCalled();
  });

  it("lets the owner upgrade and roll back with a password", async () => {
    expect(await (await GET()).json()).toEqual({ ...STATUS, can_upgrade: true });
    const res = await startPOST(post({ version: "v1.1.0", password: "pw" }));
    expect(res.status).toBe(202);
    expect(startSoftwareUpgrade).toHaveBeenCalledWith({ version: "v1.1.0", password: "pw" });
    expect((await rollbackPOST(post({ password: "pw" }))).status).toBe(202);
    expect(rollbackSoftwareUpgrade).toHaveBeenCalledWith({ password: "pw" });
  });

  it("checks the request before calling Python", async () => {
    expect((await startPOST(post("{not json"))).status).toBe(400);
    expect((await startPOST(post({ version: "main; rm -rf /", password: "pw" }))).status).toBe(400);
    expect((await startPOST(post({ version: "v1.1.0" }))).status).toBe(400);
    expect((await rollbackPOST(post({}))).status).toBe(400);
    expect(startSoftwareUpgrade).not.toHaveBeenCalled();
    expect(rollbackSoftwareUpgrade).not.toHaveBeenCalled();
  });

  it("passes Python's refusal through (wrong password)", async () => {
    startSoftwareUpgrade.mockRejectedValue(new HermesApiError(403, "That password is not right."));
    const res = await startPOST(post({ version: "v1.1.0", password: "nope" }));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toContain("password");
  });
});
