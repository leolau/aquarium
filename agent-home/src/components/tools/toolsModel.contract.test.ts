/**
 * FG-33 P8-2 contract between the Tools page and the Python tools API (2.2):
 * the batch health entries say `state`, the quota strip reads
 * `GET /api/tools/quota`, and the detail page's `runtime` row is its health.
 */
import { describe, expect, it } from "vitest";

import type { Tool } from "@/types";

import { deriveHealth, healthByName, quotaSummary } from "./toolsModel";

const TOOL = (over: Partial<Tool>): Tool =>
  ({ id: "t", name: "notes", kind: "in_house", hosting: "local", owner_user_id: "mia",
     visibility: "private", mode: "prod", enabled: true, config_json: {}, ...over }) as Tool;

describe("tools API contract", () => {
  it("reads the API's `state` health for hosted apps and local runtime rows", () => {
    const map = healthByName({
      tools: [
        { ...TOOL({ name: "site", hosting: "external", kind: "external" }), health: { state: "ok", source: "public_url" } as never },
        { ...TOOL({ name: "down" }), health: { state: "down", runtime_state: "failed" } as never },
        { ...TOOL({ name: "arch" }), health: { state: "off", runtime_state: "stopped", lifecycle_state: "archived" } as never },
      ],
    });
    expect(deriveHealth(TOOL({ name: "site", hosting: "external", kind: "external" }), map.get("site"))).toBe("running");
    expect(deriveHealth(TOOL({ name: "down" }), map.get("down"))).toBe("down");
    expect(deriveHealth(TOOL({ name: "arch" }), map.get("arch"))).toBe("off");
    expect(deriveHealth(TOOL({}), { state: "building" })).toBe("building");
  });

  it("maps /api/tools/quota usage onto the strip and hides it when unconfigured", () => {
    expect(quotaSummary({ configured: false })).toBeNull();
    expect(
      quotaSummary({
        configured: true,
        limits: { per_member: { apps_registered: 3, apps_running: 2, ram_mb: 1024, disk_mb: 4096 } },
        usage: { registered: ["a", "b"], running: ["a"], ram_mb: 300, disk_mb: null },
      }),
    ).toEqual({
      usage: { apps_registered: 2, apps_running: 1, ram_mb: 300 },
      limits: { per_member: { apps_registered: 3, apps_running: 2, ram_mb: 1024, disk_mb: 4096 } },
    });
  });
});
