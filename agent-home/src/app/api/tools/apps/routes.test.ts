/**
 * FG-33 2.1 app BFF routes: shape is checked before anything is proxied,
 * every call goes upstream as the signed-in caller (C2 decides per app),
 * and irreversible removal needs the typed app name (decision 9).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: vi.fn(async () => ({ user_id: "mia", display: "Mia", role: "member" })),
  apiClientForRequest: vi.fn(async () => ({ request })),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => {
    throw new Error("outside a request scope");
  }),
}));

import { getPrincipal } from "@/lib/auth/principal";

import * as appRoute from "./[name]/route";
import * as egress from "./[name]/egress/route";
import * as enabled from "./[name]/enabled/route";
import * as feedback from "./[name]/feedback/route";
import * as icon from "./[name]/icon/route";
import * as logs from "./[name]/logs/route";
import * as mcp from "./[name]/mcp/route";
import * as promote from "./[name]/promote/route";
import * as purge from "./[name]/purge/route";
import * as start from "./[name]/start/route";
import * as visibility from "./[name]/visibility/route";

const ctx = (name = "habit-tracker") => ({ params: Promise.resolve({ name }) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://home.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => request.mockReset());

describe("app BFF routes", () => {
  it("answers 401 without a session and proxies nothing", async () => {
    vi.mocked(getPrincipal).mockResolvedValueOnce(null);
    const res = await start.POST(req("POST", "/x", { mode: "dev" }), ctx());
    expect(res.status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a malformed name or mode before proxying", async () => {
    for (const name of ["../etc", "A b", "x/y", "-lead"]) {
      expect((await appRoute.GET(req("GET", "/x"), ctx(name))).status).toBe(400);
    }
    expect((await start.POST(req("POST", "/x", { mode: "staging" }), ctx())).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards lifecycle writes with the mode as the caller — no approval step", async () => {
    request.mockResolvedValue({ ok: true });
    const res = await promote.POST(req("POST", "/x", { mode: "dev" }), ctx());
    expect(res.status).toBe(200);
    expect(request).toHaveBeenCalledWith("/api/tools/habit-tracker/promote", {
      method: "POST",
      json: { mode: "dev" },
    });
  });

  it("refuses DELETE without the typed name, forwards it with one", async () => {
    request.mockResolvedValue({ deleted: true });
    const refused = await appRoute.DELETE(req("DELETE", "/x?mode=dev&confirm=habit"), ctx());
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("confirm_required");
    expect(request).not.toHaveBeenCalled();

    const ok = await appRoute.DELETE(req("DELETE", "/x?mode=dev&confirm=habit-tracker"), ctx());
    expect(ok.status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "/api/tools/habit-tracker?mode=dev&confirm=habit-tracker",
      { method: "DELETE" },
    );
  });

  it("refuses purge without the typed name", async () => {
    expect((await purge.POST(req("POST", "/x", { mode: "prod" }), ctx())).status).toBe(400);
    request.mockResolvedValue({});
    await purge.POST(req("POST", "/x", { mode: "prod", confirm: "habit-tracker" }), ctx());
    expect(request).toHaveBeenCalledWith("/api/tools/habit-tracker/purge", {
      method: "POST",
      json: { mode: "prod", confirm: "habit-tracker" },
    });
  });

  it("validates each write body", async () => {
    const bad = [
      enabled.POST(req("POST", "/x", { enabled: "yes" }), ctx()),
      visibility.PUT(req("PUT", "/x", { visibility: "public" }), ctx()),
      egress.PUT(req("PUT", "/x", { hosts: ["10.0.0.1"] }), ctx()),
      egress.PUT(req("PUT", "/x", { hosts: ["api.example.com/path"] }), ctx()),
      feedback.POST(req("POST", "/x", { text: "  " }), ctx()),
      icon.PUT(req("PUT", "/x", { icon_source: "generated", icon: "ABC" }), ctx()),
      icon.PUT(req("PUT", "/x", { icon_source: "generated", icon: "A", icon_color: "#fff" }), ctx()),
      icon.PUT(req("PUT", "/x", { icon_source: "hotlink" }), ctx()),
      mcp.PUT(req("PUT", "/x", {}), ctx()),
      logs.GET(req("GET", "/x?lines=99999"), ctx()),
    ];
    for (const res of await Promise.all(bad)) expect(res.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("maps enabled to the upstream PUT and dedupes egress hosts", async () => {
    request.mockResolvedValue({});
    await enabled.POST(req("POST", "/x", { enabled: false, mode: "prod" }), ctx());
    expect(request).toHaveBeenLastCalledWith("/api/tools/habit-tracker/enabled", {
      method: "PUT",
      json: { enabled: false, mode: "prod" },
    });
    await egress.PUT(req("PUT", "/x", { hosts: ["api.example.com", "api.example.com"] }), ctx());
    expect(request).toHaveBeenLastCalledWith("/api/tools/habit-tracker/egress", {
      method: "PUT",
      json: { hosts: ["api.example.com"], mode: undefined },
    });
    await logs.GET(req("GET", "/x?mode=dev"), ctx());
    expect(request).toHaveBeenLastCalledWith("/api/tools/habit-tracker/logs?mode=dev&lines=200");
  });
});
