// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonalMcpServers } from "@/components/settings/PersonalMcpServers";
import en from "@/i18n/messages/en/extraTools.json";
import zh from "@/i18n/messages/zh-Hant/extraTools.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = handler(String(input), init);
      const status = result instanceof Response ? result.status : 200;
      const body = result instanceof Response ? await result.text() : JSON.stringify(result);
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    });
}

const NOTION = {
  name: "notion",
  url: "https://mcp.notion.com/mcp",
  auth: null,
  header_names: ["Authorization"],
};

describe("PersonalMcpServers", () => {
  it("has the same keys in English and 繁中", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("shows the empty state", async () => {
    mockFetch(() => ({ configured: true, servers: [], limit: 20 }));
    render(<PersonalMcpServers />);
    expect(await screen.findByText(en.empty)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.add })).toBeTruthy();
  });

  it("adds a server, then tests it, blocking repeat clicks", async () => {
    const calls: string[] = [];
    let servers: unknown[] = [];
    mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/tools/personal-mcp" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          name: "notion",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer k" },
        });
        servers = [NOTION];
        return NOTION;
      }
      if (url.endsWith("/test")) return { ok: true, tools: [{ name: "search", description: "" }] };
      return { configured: true, servers, limit: 20 };
    });
    const onCount = vi.fn();
    render(<PersonalMcpServers onCount={onCount} />);
    fireEvent.click(await screen.findByRole("button", { name: en.add }));
    fireEvent.change(screen.getByPlaceholderText(en.namePh), { target: { value: "notion" } });
    fireEvent.change(screen.getByPlaceholderText(en.urlPh), {
      target: { value: "https://mcp.notion.com/mcp" },
    });
    fireEvent.change(screen.getByPlaceholderText(en.headerNamePh), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByPlaceholderText(en.headerValuePh), { target: { value: "Bearer k" } });
    fireEvent.click(screen.getByRole("button", { name: en.save }));
    expect(await screen.findByText("✓ Works. 1 tools.")).toBeTruthy();
    expect(calls).toContain("POST /api/tools/personal-mcp/notion/test");
    expect(onCount).toHaveBeenLastCalledWith(1);
    expect(screen.queryByText("Bearer k")).toBeNull();
  });

  it("shows the server's error when a save is refused", async () => {
    mockFetch((_url, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ detail: "'localhost' is on this server or a private network." }), {
            status: 400,
          })
        : { configured: true, servers: [], limit: 20 },
    );
    render(<PersonalMcpServers />);
    fireEvent.click(await screen.findByRole("button", { name: en.add }));
    fireEvent.change(screen.getByPlaceholderText(en.namePh), { target: { value: "x" } });
    fireEvent.change(screen.getByPlaceholderText(en.urlPh), { target: { value: "http://localhost/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: en.save }));
    expect(await screen.findByText(/private network/)).toBeTruthy();
  });

  it("asks before removing", async () => {
    let servers: unknown[] = [NOTION];
    const deleted: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "DELETE") {
        deleted.push(url);
        servers = [];
        return { ok: true };
      }
      return { configured: true, servers, limit: 20 };
    });
    render(<PersonalMcpServers />);
    fireEvent.click(await screen.findByRole("button", { name: en.remove }));
    expect(screen.getByText("Remove notion?")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: en.remove });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(deleted).toEqual(["/api/tools/personal-mcp/notion"]));
    expect(await screen.findByText(en.empty)).toBeTruthy();
  });

  it("explains installs without per-person sign-in", async () => {
    mockFetch(() => ({ configured: false, servers: [], limit: 20 }));
    render(<PersonalMcpServers />);
    expect(await screen.findByText(en.notConfigured)).toBeTruthy();
  });

  it("offers sign-in for an OAuth server", async () => {
    mockFetch(() => ({
      configured: true,
      servers: [{ ...NOTION, auth: "oauth", header_names: [], oauth_token_present: false }],
      limit: 20,
    }));
    render(<PersonalMcpServers />);
    expect(await screen.findByText(en.needsSignIn)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy();
  });
});
