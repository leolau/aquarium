// @vitest-environment jsdom
/**
 * Tools page v2 invariants (FG-33 §7): local vs hosted differ by shape and
 * badge (not colour alone), ready tiles open in a new tab safely, others open
 * the sheet, and destructive actions take one confirmation guarded by
 * `data-appmcp-deny` — with no approval step for a member's own app.
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ToolsRegistry, type ToolsPageData } from "@/components/tools/ToolsRegistry";
import type { Tool } from "@/types";

const TOOL = (over: Partial<Tool>): Tool =>
  ({
    id: over.name ?? "t",
    name: "habit-tracker",
    kind: "in_house",
    hosting: "local",
    owner_user_id: "mia",
    visibility: "private",
    mode: "prod",
    enabled: true,
    config_json: {},
    display_name: null,
    icon: null,
    icon_color: null,
    icon_asset_id: null,
    icon_source: "generated",
    public_url: null,
    dashboard_url: null,
    build_state: "ready",
    ...over,
  }) as Tool;

const DATA = (tools: Tool[], health: ToolsPageData["health"] = {}): ToolsPageData => ({
  configured: true,
  mode: "prod",
  tools,
  health,
});

const MIA = { user_id: "mia", role: "member" as const, is_owner: false };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("ToolsRegistry v2", () => {
  it("splits local, hosted and helper rows, distinguished by shape and badge", () => {
    const { container } = render(
      <ToolsRegistry
        viewer={MIA}
        data={DATA(
          [
            TOOL({ name: "habit-tracker" }),
            TOOL({ name: "shop", kind: "external", hosting: "external", public_url: "https://shop.example.com", config_json: { provider: "vercel" } }),
            TOOL({ name: "pdf-helper", kind: "remote", hosting: undefined as never }),
          ],
          { "habit-tracker": { runtime_state: "running" }, shop: { health: "ok" } },
        )}
      />,
    );
    const local = container.querySelector('[data-section="local"] [data-component="AppTile"]')!;
    const ext = container.querySelector('[data-section="external"] [data-component="AppTile"]')!;
    expect(local.getAttribute("data-kind")).toBe("local");
    expect(local.querySelector("[data-shape]")!.getAttribute("data-shape")).toBe("squircle");
    expect(local.querySelector('[data-provider="box"]')).not.toBeNull();
    expect(ext.querySelector("[data-shape]")!.getAttribute("data-shape")).toBe("circle");
    expect(ext.querySelector('[data-provider="vercel"]')).not.toBeNull();
    expect(ext.querySelector("[data-external-arrow]")!.textContent).toBe("↗");
    const helpers = container.querySelector('[data-section="helpers"]')!;
    expect(within(helpers as HTMLElement).getByText("pdf-helper")).toBeTruthy();
  });

  it("opens ready tiles in a safe new tab and labels health in text", () => {
    const { container } = render(
      <ToolsRegistry viewer={MIA} data={DATA([TOOL({})], { "habit-tracker": { runtime_state: "running" } })} />,
    );
    const link = container.querySelector('[data-component="AppTile"] a')!;
    expect(link.getAttribute("href")).toBe("/apps/habit-tracker/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toContain("Running");
  });

  it("shows the empty state with both build deep links", () => {
    const { getByText } = render(<ToolsRegistry viewer={MIA} data={DATA([])} />);
    expect(getByText("Build a local app").getAttribute("href")).toMatch(/^\/chat\?draft=/);
    expect(getByText("Build a hosted app").getAttribute("href")).toMatch(/^\/chat\?draft=/);
  });

  it("opens the sheet for a stopped app; delete takes one guarded confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, getByText, getByRole } = render(
      <ToolsRegistry viewer={MIA} data={DATA([TOOL({})], { "habit-tracker": { runtime_state: "stopped" } })} />,
    );
    fireEvent.click(container.querySelector('[data-component="AppTile"] button')!);
    const del = getByText("Delete app…");
    expect(del.closest("[data-appmcp-deny]")).not.toBeNull();
    fireEvent.click(del);
    const dialog = getByRole("dialog", { name: /Delete habit-tracker\?/ });
    expect(dialog.closest("[data-appmcp-deny]")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Delete"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tools/apps/habit-tracker?mode=prod&confirm=habit-tracker");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("hides manage actions on someone else's shared app", () => {
    const { container, queryByText } = render(
      <ToolsRegistry
        viewer={MIA}
        data={DATA([TOOL({ owner_user_id: "leo", visibility: "shared" })], { "habit-tracker": { runtime_state: "stopped" } })}
      />,
    );
    fireEvent.click(container.querySelector('[data-component="AppTile"] button')!);
    expect(queryByText("Delete app…")).toBeNull();
    expect(queryByText("Start")).toBeNull();
    expect(queryByText("Ask the agent to change it")).not.toBeNull();
  });

  it("gives every tools component root a data-component", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => /^[A-Z].*\.tsx$/.test(f) && !f.includes(".test."))) {
      expect(readFileSync(`${dir}/${file}`, "utf8"), file).toMatch(/data-component="/);
    }
  });
});
