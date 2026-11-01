import { describe, expect, it } from "vitest";

// Phase 1 registrations run at import — the same moment they run in the app.
import "@/components/coral/coral-apps";
import {
  __resetCoralRegistryForTests,
  buildCoralLayout,
  getApps,
  isAppActive,
  registerApp,
  registerCluster,
} from "@/components/coral/coral-registry";
import type { AppManifest } from "@/components/coral/coral-types";

const app = (over: Partial<AppManifest> & { id: string }): AppManifest => ({
  name: over.id,
  glyph: "◦",
  kind: "next-route",
  route: `/${over.id}`,
  category: over.id,
  order: 0,
  ...over,
});

describe("coral Phase 1 registrations", () => {
  it("registers all 18 destinations with unique ids and routes", () => {
    const apps = getApps();
    expect(apps).toHaveLength(18);
    expect(new Set(apps.map((a) => a.id)).size).toBe(18);
    expect(new Set(apps.map((a) => a.route)).size).toBe(18);
  });

  it("builds 8 petals: 6 apps + 2 clusters, in order-band sequence", () => {
    const petals = buildCoralLayout();
    expect(petals).toHaveLength(8);
    expect(petals.map((p) => (p.type === "app" ? p.app.id : `cluster:${p.id}`))).toEqual([
      "home",
      "todos",
      "chat",
      "inbox",
      "memory",
      "projects",
      "cluster:workspace",
      "cluster:system",
    ]);
  });

  it("clusters hold the remaining 12 destinations", () => {
    const petals = buildCoralLayout();
    const workspace = petals.find((p) => p.type === "cluster" && p.id === "workspace");
    const system = petals.find((p) => p.type === "cluster" && p.id === "system");
    if (workspace?.type !== "cluster" || system?.type !== "cluster") {
      throw new Error("expected both clusters");
    }
    expect(workspace.members.map((m) => m.id)).toEqual([
      "files",
      "activity",
      "graph",
      "capacity",
    ]);
    expect(system.members.map((m) => m.id)).toEqual([
      "users",
      "suggestions",
      "tools",
      "models",
      "core",
      "webview",
      "settings",
      "onboarding",
    ]);
  });

  it("keeps every registered app reachable from the layout exactly once", () => {
    const laid = buildCoralLayout();
    const ids = laid.flatMap((p) =>
      p.type === "app" ? [p.app.id] : p.members.map((m) => m.id),
    );
    expect(ids.sort()).toEqual(getApps().map((a) => a.id).sort());
  });

  it("keeps the badge-slot contract: exactly one todos-open slot", () => {
    const slots = getApps().filter((a) => a.badgeSlot === "todos-open");
    expect(slots.map((a) => a.id)).toEqual(["todos"]);
  });

  it("matches the old isActive semantics (root exact, others by prefix)", () => {
    expect(isAppActive("/", "/")).toBe(true);
    expect(isAppActive("/todos", "/")).toBe(false);
    expect(isAppActive("/todos/abc", "/todos")).toBe(true);
    expect(isAppActive("/tools", "/todos")).toBe(false);
  });
});

describe("coral per-role filtering (Settings → Menu)", () => {
  const ids = (petals: ReturnType<typeof buildCoralLayout>) =>
    petals.flatMap((p) => (p.type === "app" ? [p.app.id] : p.members.map((a) => a.id)));

  it("drops hidden apps from the top level and from clusters", () => {
    const petals = buildCoralLayout({ hidden: ["todos", "graph"] });
    expect(ids(petals)).not.toContain("todos");
    expect(ids(petals)).not.toContain("graph");
    expect(ids(petals)).toHaveLength(getApps().length - 2);
  });

  it("removes a cluster whose members are all hidden", () => {
    const system = getApps()
      .filter((a) => a.category === "system" && a.id !== "settings")
      .map((a) => a.id);
    const workspace = getApps()
      .filter((a) => a.category === "workspace")
      .map((a) => a.id);
    const petals = buildCoralLayout({ hidden: workspace });
    expect(petals.some((p) => p.type === "cluster" && p.id === "workspace")).toBe(false);
    // Settings is locked, so System survives even with every other member hidden.
    const sys = buildCoralLayout({ hidden: system }).find((p) => p.type === "cluster" && p.id === "system");
    expect(sys && sys.type === "cluster" ? sys.members.map((a) => a.id) : []).toEqual(["settings"]);
  });

  it("never hides the locked Home and Settings", () => {
    expect(ids(buildCoralLayout({ hidden: ["home", "settings"] })).sort()).toEqual(
      ids(buildCoralLayout()).sort(),
    );
  });
});

describe("coral caps and registration errors", () => {
  it("rejects a 9th top-level petal, naming the fix", () => {
    __resetCoralRegistryForTests();
    for (let i = 0; i < 9; i += 1) {
      registerApp(app({ id: `app-${i}`, order: i }));
    }
    expect(() => buildCoralLayout()).toThrow(/cap of 8.*cluster/);
  });

  it("rejects a 9th cluster member", () => {
    __resetCoralRegistryForTests();
    registerCluster("system", { label: "System", glyph: "❖" });
    for (let i = 0; i < 9; i += 1) {
      registerApp(app({ id: `s-${i}`, category: "system", order: i }));
    }
    expect(() => buildCoralLayout()).toThrow(/cap is 8/);
  });

  it("rejects two apps in one non-cluster category", () => {
    __resetCoralRegistryForTests();
    registerApp(app({ id: "one", category: "solo", order: 0 }));
    registerApp(app({ id: "two", category: "solo", route: "/two", order: 1 }));
    expect(() => buildCoralLayout()).toThrow(/not a cluster/);
  });

  it("rejects a cluster category with no registerCluster definition", () => {
    __resetCoralRegistryForTests();
    registerApp(app({ id: "orphan", category: "system", order: 0 }));
    expect(() => buildCoralLayout()).toThrow(/no registerCluster/);
  });

  it("rejects duplicate ids and routes at registration", () => {
    __resetCoralRegistryForTests();
    registerApp(app({ id: "dup" }));
    expect(() => registerApp(app({ id: "dup", route: "/other" }))).toThrow(/duplicate app id/);
    expect(() => registerApp(app({ id: "other", route: "/dup" }))).toThrow(/reuses route/);
  });

  it("rejects routes without a leading slash", () => {
    __resetCoralRegistryForTests();
    expect(() => registerApp(app({ id: "bad", route: "todos" }))).toThrow(/must start with/);
  });
});
