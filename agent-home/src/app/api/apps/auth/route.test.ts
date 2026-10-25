import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/apps/auth/route";
import { HermesApiError } from "@/lib/api/client";
import { clearAppAccessCache } from "@/lib/apps/access";
import { deriveAppKey, verifyAppTicket } from "@/lib/apps/ticket";
import type { Principal, Tool, ToolsResponse } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const tools = vi.fn<(mode?: string) => Promise<ToolsResponse>>();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ tools: (mode?: string) => tools(mode) }),
}));

const MASTER = "front-door-master";
const ann: Principal = { user_id: "ann", display: "Ann", role: "member", channels: [], is_owner: false };

function tool(over: Partial<Tool>): Tool {
  return {
    id: "t1",
    name: "notes",
    kind: "app",
    stack: "nextjs",
    owner_user_id: "leo",
    visibility: "shared",
    mode: "prod",
    status: "ready",
    enabled: true,
    mcp_endpoint_ref: null,
    web_url: null,
    config_json: {},
    hosting: "local",
    ...over,
  } as Tool;
}

function registry(rows: Tool[]) {
  tools.mockImplementation(async (mode) => ({
    configured: true,
    mode: (mode ?? "prod") as "prod" | "dev",
    tools: rows.filter((r) => r.mode === (mode ?? "prod")),
  }));
}

function call(uri: string, app: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    host: "home.example.com",
    "x-forwarded-uri": uri,
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    ...extra,
  };
  if (app) headers["x-aquarium-app"] = app;
  return GET(new Request("http://127.0.0.1:3100/api/apps/auth", { headers }));
}

describe("GET /api/apps/auth (forward_auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAppAccessCache();
    vi.stubEnv("AGENT_HOME_APPS_TICKET_SECRET", MASTER);
    getPrincipal.mockResolvedValue(ann);
    registry([tool({}), tool({ id: "t2", mode: "dev", enabled: false })]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("hands a readable app a ticket only that app instance can verify", async () => {
    const res = await call("/apps/notes/board", "notes/prod");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ticket = res.headers.get("x-aquarium-principal")!;
    const claims = verifyAppTicket(ticket, deriveAppKey(MASTER, "notes", "prod"), "notes/prod");
    expect(claims?.sub).toBe("ann");
    expect(verifyAppTicket(ticket, deriveAppKey(MASTER, "notes", "dev"), "notes/dev")).toBeNull();
  });

  it("serves the dev build at /apps-dev even while the prod app is disabled", async () => {
    registry([tool({ enabled: false }), tool({ id: "t2", mode: "dev", enabled: false })]);
    expect((await call("/apps-dev/notes/", "notes/dev")).status).toBe(200);
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(404);
  });

  it("404s apps the visitor's C2 scope cannot read, external apps and unknown slugs", async () => {
    registry([
      tool({ visibility: "private:leo" }),
      tool({ id: "t3", name: "site", hosting: "external" }),
    ]);
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(404);
    expect((await call("/apps/site/", "site/prod")).status).toBe(404);
    expect((await call("/apps/missing/", "missing/prod")).status).toBe(404);
  });

  it("lets the owner open a member's private app", async () => {
    getPrincipal.mockResolvedValue({ ...ann, user_id: "leo", role: "owner", is_owner: true });
    registry([tool({ owner_user_id: "ann", visibility: "private:ann" })]);
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(200);
  });

  it("refuses when the routed instance and the requested path disagree", async () => {
    expect((await call("/apps/notes/", "other/prod")).status).toBe(404);
    expect((await call("/apps/notes/", "notes/dev")).status).toBe(404);
    expect((await call("/apps/notes/", null)).status).toBe(404);
    expect((await call("/apps/other/../notes/", "notes/prod")).status).toBe(404);
    expect(tools).not.toHaveBeenCalled();
  });

  it("refuses another app's page driving this app with the visitor's identity", async () => {
    const res = await call("/apps/notes/api/delete", "notes/prod", {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: "https://home.example.com/apps/evil/",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-aquarium-principal")).toBeNull();
  });

  it("sends signed-out page loads to login and answers other requests 401", async () => {
    getPrincipal.mockResolvedValue(null);
    const nav = await call("/apps/notes/", "notes/prod");
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe("/login");
    const fetchRes = await call("/apps/notes/api/x", "notes/prod", {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: "https://home.example.com/apps/notes/",
    });
    expect(fetchRes.status).toBe(401);
  });

  it("treats an expired upstream token as signed out", async () => {
    tools.mockRejectedValue(new HermesApiError(401, "expired"));
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(302);
  });

  it("fails closed with 503 when unconfigured or the registry is down", async () => {
    vi.stubEnv("AGENT_HOME_APPS_TICKET_SECRET", "");
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(503);
    vi.stubEnv("AGENT_HOME_APPS_TICKET_SECRET", MASTER);
    tools.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await call("/apps/notes/", "notes/prod")).status).toBe(503);
  });
});
