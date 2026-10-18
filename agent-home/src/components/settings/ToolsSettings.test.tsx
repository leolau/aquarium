// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolsSettings } from "@/components/settings/ToolsSettings";
import type { McpServer, Toolset } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

afterEach(cleanup);

const CANVA: McpServer = {
  name: "canva",
  transport: "http",
  url: "https://mcp.canva.com/mcp",
  auth: "oauth",
  enabled: true,
  oauth_token_present: false,
};

const FIGMA: McpServer = {
  name: "figma",
  transport: "stdio",
  command: "npx",
  args: ["-y", "figma-developer-mcp@0.13.2"],
  enabled: true,
};

const TOOLSET: Toolset = {
  name: "web",
  label: "Web tools",
  description: "Search and fetch.",
  enabled: true,
  available: true,
  configured: true,
  tools: ["web_search", "web_fetch"],
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const result = handler(url, init);
      const status = result instanceof Response ? result.status : 200;
      const body = result instanceof Response ? await result.text() : JSON.stringify(result);
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    });
}

describe("ToolsSettings", () => {
  it("lists MCP servers with auth state and actions", () => {
    render(<ToolsSettings servers={[CANVA, FIGMA]} toolsets={[]} />);
    expect(screen.getByText("canva")).toBeTruthy();
    expect(screen.getByText("needs auth")).toBeTruthy();
    expect(screen.getByText("Re-authenticate")).toBeTruthy();
    expect(screen.getByText("figma")).toBeTruthy();
    // A stdio server has no OAuth affordance.
    const figmaRow = screen.getByText("figma").closest("li")!;
    expect(figmaRow.textContent).not.toContain("Re-authenticate");
  });

  it("posts the enable toggle for a toolset", async () => {
    const calls: Array<[string, string, unknown]> = [];
    mockFetch((url, init) => {
      calls.push([init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) : null]);
      return { ok: true };
    });
    render(<ToolsSettings servers={[]} toolsets={[TOOLSET]} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0][0]).toBe("POST");
    expect(calls[0][1]).toBe("/api/tools/toolsets/web");
    expect(calls[0][2]).toEqual({ enabled: false });
  });

  it("labels the section for Aquarium chats and lists the groups that are on", () => {
    const off: Toolset = { ...TOOLSET, name: "terminal", label: "Terminal", enabled: false, tools: ["terminal"] };
    render(<ToolsSettings servers={[]} toolsets={[TOOLSET, off]} />);
    expect(screen.getByText("Tool groups for Aquarium chats")).toBeTruthy();
    expect(screen.queryByText("CLI toolsets")).toBeNull();
    expect(screen.getByTestId("chat-tool-groups-on").textContent).toBe(
      "New chats can use: Web tools.",
    );
    expect(screen.getByText("Tools: web_search, web_fetch")).toBeTruthy();
  });

  it("starts the OAuth flow and shows the authorization link", async () => {
    mockFetch((url) => {
      if (url.endsWith("/oauth/start")) return { status: "starting" };
      if (url.endsWith("/oauth/status"))
        return {
          status: "waiting_user",
          authorization_url: "https://canva.com/oauth?client=x",
        };
      return {};
    });
    render(<ToolsSettings servers={[CANVA]} toolsets={[]} />);
    fireEvent.click(screen.getByText("Re-authenticate"));
    expect(
      await screen.findByText("Open authorization page", {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText(/127\.0\.0\.1/)).toBeTruthy();
  }, 10000);

  it("delivers the pasted redirect URL to the flow", async () => {
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "POST") posts.push(url);
      if (url.endsWith("/oauth/status"))
        return { status: "waiting_user", authorization_url: "https://x" };
      return { ok: true };
    });
    render(<ToolsSettings servers={[CANVA]} toolsets={[]} />);
    fireEvent.click(screen.getByText("Re-authenticate"));
    const input = await screen.findByPlaceholderText(/127\.0\.0\.1/, {}, { timeout: 4000 });
    fireEvent.change(input, {
      target: { value: "http://127.0.0.1:7777/callback?code=abc&state=s" },
    });
    fireEvent.click(screen.getByText("Complete"));
    await waitFor(() =>
      expect(posts.some((u) => u.endsWith("/oauth/redirect"))).toBe(true),
    );
  }, 10000);

  it("shows the lists read-only when the viewer cannot manage tools", () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return { ok: true };
    });
    render(
      <ToolsSettings servers={[CANVA, FIGMA]} toolsets={[TOOLSET]} canManage={false} />,
    );
    expect(screen.getByTestId("tools-read-only-note").textContent).toContain(
      "Only the owner or an admin can change tools and integrations.",
    );
    expect(screen.getByText("canva")).toBeTruthy();
    expect(screen.getByText("needs auth")).toBeTruthy();
    expect(screen.getByText("Web tools")).toBeTruthy();
    for (const label of ["Test connection", "Re-authenticate", "Remove", "Enable"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // The only remaining button is the toolset switch, and it is disabled.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]);
    expect(calls).toEqual([]);
  });
});
