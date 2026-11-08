import { describe, expect, it } from "vitest";

import { logicalParent, routeTrail } from "./route-trail";

const hrefs = (p: string) => routeTrail(p).map((c) => c.href);

describe("routeTrail", () => {
  it("chains every page back to Home through its logical parent", () => {
    expect(hrefs("/projects/tender/cards/c1")).toEqual(["/", "/projects", "/projects/tender", "/projects/tender/cards/c1"]);
    expect(hrefs("/projects/tender/runs/12")).toEqual(["/", "/projects", "/projects/tender", "/projects/tender/runs/12"]);
    expect(hrefs("/skills/foo/edit")).toEqual(["/", "/system", "/skills", "/skills/foo", "/skills/foo/edit"]);
    expect(hrefs("/inbox/42")).toEqual(["/", "/inbox", "/inbox/42"]);
    expect(hrefs("/todos/7")).toEqual(["/", "/todos", "/todos/7"]);
    expect(hrefs("/users")).toEqual(["/", "/settings", "/users"]);
    expect(hrefs("/webview")).toEqual(["/", "/system", "/webview"]);
  });

  it("prefers static segments over params", () => {
    expect(logicalParent("/projects/new")?.href).toBe("/projects");
    expect(routeTrail("/settings/get-ready").at(-1)?.label).toBe("Get ready");
  });

  it("applies label overrides by href", () => {
    const trail = routeTrail("/projects/tender/cards/c1", { "/projects/tender": "Tender bids" });
    expect(trail[2]).toEqual({ label: "Tender bids", href: "/projects/tender" });
  });

  it("falls back to the nearest known ancestor for unknown paths", () => {
    expect(logicalParent("/projects/tender/unknown/x")?.href).toBe("/projects/tender");
    expect(logicalParent("/nowhere")?.href).toBe("/");
  });

  it("ignores query, hash and trailing slashes; Home has no parent", () => {
    expect(logicalParent("/todos/7/?x=1#y")?.href).toBe("/todos");
    expect(logicalParent("/")).toBeNull();
  });
});
