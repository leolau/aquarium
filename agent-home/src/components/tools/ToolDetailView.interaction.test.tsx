// @vitest-environment jsdom
/**
 * `/tools/[name]` mounts item 2.7's secrets form for local apps only, inside
 * its `data-appmcp-deny` region, editable only by people who may act on the app.
 */
import { cleanup, render } from "@testing-library/react";
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
    expect(form?.querySelector("input")).not.toBeNull();
  });

  it("is read-only for a member who does not own the app and absent for hosted apps", () => {
    const shared = render(<ToolDetailView data={{ tool: TOOL({}) }} viewer={BEN} />);
    const form = shared.container.querySelector('[data-component="AppSecretsForm"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector("input")).toBeNull();
    cleanup();
    const hosted = render(
      <ToolDetailView data={{ tool: TOOL({ hosting: "external", kind: "external" }) }} viewer={MIA} />,
    );
    expect(hosted.container.querySelector('[data-component="AppSecretsForm"]')).toBeNull();
  });
});
