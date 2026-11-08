// @vitest-environment jsdom
/**
 * `/tools/[name]` mounts item 2.7's secrets form for local apps only, inside
 * its `data-appmcp-deny` region, editable only by people who may act on the app.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ToolDetailView } from "@/components/tools/ToolDetailView";
import type { Tool } from "@/types";

const TOOL = (over: Partial<Tool>): Tool =>
  ({ id: "t", name: "notes", kind: "in_house", hosting: "local", owner_user_id: "mia",
     visibility: "shared", mode: "dev", enabled: true, config_json: {},
     secret_names: ["STRIPE_KEY"], ...over }) as Tool;

const MIA = { user_id: "mia", role: "member" as const, is_owner: false };
const BEN = { user_id: "ben", role: "member" as const, is_owner: false };

afterEach(cleanup);

describe("ToolDetailView secrets", () => {
  it("shows the secrets form for a local app, behind data-appmcp-deny", () => {
    const { container } = render(<ToolDetailView data={{ tool: TOOL({}) }} viewer={MIA} />);
    const form = container.querySelector('[data-component="AppSecretsForm"]');
    expect(form).not.toBeNull();
    expect(form?.getAttribute("data-appmcp-deny")).toBe("secret");
    expect(form?.textContent).toContain("STRIPE_KEY");
    expect(form?.querySelector("input")).toBeNull();
    fireEvent.click(within(form as HTMLElement).getByRole("button", { name: "Manage secrets" }));
    expect(form?.querySelector("input")).not.toBeNull();
  });

  it("is read-only for a member who does not own the app and absent for hosted apps", () => {
    const shared = render(<ToolDetailView data={{ tool: TOOL({}) }} viewer={BEN} />);
    const form = shared.container.querySelector('[data-component="AppSecretsForm"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector("input")).toBeNull();
    expect(within(form as HTMLElement).queryByRole("button", { name: "Manage secrets" })).toBeNull();
    cleanup();
    const hosted = render(
      <ToolDetailView data={{ tool: TOOL({ hosting: "external", kind: "external" }) }} viewer={MIA} />,
    );
    expect(hosted.container.querySelector('[data-component="AppSecretsForm"]')).toBeNull();
  });
});

describe("ToolDetailView deployments", () => {
  const DEPLOYS = [
    { id: "d4", status: "live" as const, mode: "prod", url: "/apps/notes/", source_sha: "3f9a2c1d7e04aa", created_at: "2026-11-08T10:00:00Z" },
    { id: "d3", status: "test" as const, mode: "dev", url: "/apps-dev/notes/", created_at: "2026-11-08T09:00:00Z" },
    { id: "d2", status: "failed" as const, mode: "dev", url: "/apps-dev/notes/", error: "npm ERR! build", created_at: "2026-11-07T20:00:00Z" },
    { id: "d1", status: "superseded" as const, mode: "prod", url: "/apps/notes/", source_sha: "91be0a77c2d3bbff", created_at: "2026-11-07T09:00:00Z" },
  ];

  it("shows a status pill per deployment with when and where", () => {
    const { container } = render(
      <ToolDetailView data={{ tool: TOOL({}), deployments: DEPLOYS, secrets: [] }} viewer={MIA} />,
    );
    const card = container.querySelector('[data-component="ToolDeployments"]') as HTMLElement;
    const rows = [...card.querySelectorAll("li")];
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["live", "test", "failed", "superseded"]);
    expect(rows[0].textContent).toContain("Live");
    expect(rows[0].textContent).toContain("/apps/notes/");
    expect(rows[1].textContent).toContain("Test copy");
    expect(rows[2].textContent).toContain("npm ERR! build");
    expect(rows[3].textContent).toContain("Superseded");
    expect(rows[3].textContent).toContain("release 91be0a77c2d3");
    expect(within(card).getByRole("button", { name: "About deployments" })).toBeTruthy();
  });

  it("explains an empty list for a local app and orders cards as the phone mockup", () => {
    const { container } = render(<ToolDetailView data={{ tool: TOOL({}) }} viewer={MIA} />);
    const card = container.querySelector('[data-component="ToolDeployments"]');
    expect(card?.textContent).toContain("No deployments yet");
    const order = (el: Element | null | undefined) =>
      Number(/(?:^| )order-(\d)/.exec(el?.className ?? "")?.[1]);
    expect(order(container.querySelector("#tool-feedback"))).toBeLessThan(order(card?.parentElement));
    expect(order(card?.parentElement)).toBeLessThan(
      order(container.querySelector('[data-component="AppSecretsForm"]')?.parentElement),
    );
  });
});
