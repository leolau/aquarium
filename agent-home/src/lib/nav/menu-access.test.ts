import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import "@/components/coral/coral-apps";
import { getApps } from "@/components/coral/coral-registry";
import {
  APP_URLS,
  blockedAppForPath,
  LOCKED_APP_IDS,
  normalizePath,
  ROLE_GATED_APPS,
  sanitizeHidden,
  seesEverything,
} from "@/lib/nav/menu-access";

describe("menu access mapping", () => {
  it("covers exactly the launcher's hideable apps", () => {
    const hideable = getApps()
      .map((a) => a.id)
      .filter((id) => !LOCKED_APP_IDS.includes(id))
      .sort();
    expect([...ROLE_GATED_APPS].sort()).toEqual(hideable);
  });

  it("accepts the same app ids as the Python API", () => {
    const src = readFileSync(resolve(__dirname, "../../../../hermes_cli/agent_home_nav.py"), "utf8");
    const block = /KNOWN_APP_IDS = \(([\s\S]*?)\)/.exec(src)?.[1] ?? "";
    const pyIds = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(pyIds).toEqual(getApps().map((a) => a.id).sort());
  });

  it("maps every app's launcher route to its own page rule", () => {
    for (const app of getApps()) {
      if (LOCKED_APP_IDS.includes(app.id) || !app.route) continue;
      expect(blockedAppForPath(app.route, [app.id])).toEqual({ app: app.id, kind: "page" });
    }
  });

  it("blocks a hidden app's pages and APIs only", () => {
    expect(blockedAppForPath("/graph", ["graph"])).toEqual({ app: "graph", kind: "page" });
    expect(blockedAppForPath("/todos/abc", ["todos"])).toEqual({ app: "todos", kind: "page" });
    expect(blockedAppForPath("/api/todos/abc", ["todos"])).toEqual({ app: "todos", kind: "api" });
    expect(blockedAppForPath("/graph", ["todos"])).toBeNull();
    expect(blockedAppForPath("/graphs", ["graph"])).toBeNull();
  });

  it("keeps deep links that other visible features use", () => {
    // Project links from chat / todos / activity open /projects/<id>.
    expect(blockedAppForPath("/projects/p1", ["projects"])).toBeNull();
    expect(blockedAppForPath("/api/projects/p1", ["projects"])).toBeNull();
    expect(blockedAppForPath("/projects", ["projects"])).toEqual({ app: "projects", kind: "page" });
    // A single incoming opened from a notification stays reachable.
    expect(blockedAppForPath("/inbox/i1", ["inbox"])).toBeNull();
    expect(blockedAppForPath("/api/incomings/i1", ["inbox"])).toBeNull();
    // Chat APIs feed the badge and other surfaces.
    expect(blockedAppForPath("/api/chat/sessions", ["chat"])).toBeNull();
  });

  it("never blocks locked or unknown apps", () => {
    expect(blockedAppForPath("/", ["home"])).toBeNull();
    expect(blockedAppForPath("/settings", ["settings"])).toBeNull();
    expect(blockedAppForPath("/x", ["nope"])).toBeNull();
    for (const urls of Object.values(APP_URLS)) {
      for (const rule of urls.pages) expect(rule.path.startsWith("/settings")).toBe(false);
    }
  });

  it("treats the owner as seeing everything", () => {
    expect(seesEverything({ role: "owner" })).toBe(true);
    expect(seesEverything({ role: "admin", is_owner: true })).toBe(true);
    expect(seesEverything({ role: "admin" })).toBe(false);
  });

  it("sanitizes hidden lists", () => {
    expect(sanitizeHidden(["graph", "home", "graph", 3, "settings"])).toEqual(["graph"]);
  });

  it("normalizes path variants before matching", () => {
    expect(normalizePath("/todos/")).toBe("/todos");
    expect(normalizePath("//todos")).toBe("/todos");
    expect(normalizePath("/%74odos")).toBe("/todos");
    expect(normalizePath("/%2574odos")).toBe("/todos");
    expect(normalizePath("/a/../todos")).toBe("/todos");
    expect(normalizePath("/api//todos/")).toBe("/api/todos");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/%E0%A4%A")).toBe("/%E0%A4%A");
    expect(blockedAppForPath("/%74odos/", ["todos"])).toEqual({ app: "todos", kind: "page" });
    expect(blockedAppForPath("//api/todos", ["todos"])).toEqual({ app: "todos", kind: "api" });
  });
});
