// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoleLimitsSection } from "@/components/settings/RoleLimitsSection";
import type { RoleLimit, RoleToolGroup } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function group(name: string, label: string, tools: string[], blocked: string[], risky = false): RoleToolGroup {
  return {
    name,
    label,
    description: "",
    risky,
    state: blocked.length === 0 ? "allowed" : blocked.length === tools.length ? "blocked" : "partial",
    tools,
    blocked_tools: blocked,
  };
}

function role(name: RoleLimit["role"], label: string, blocked: string[], extra: Partial<RoleLimit> = {}): RoleLimit {
  const b = new Set(blocked);
  return {
    role: name,
    label,
    locked: name === "owner",
    customised: false,
    files: name === "owner" || name === "admin" ? "any" : "own_folder",
    files_customised: false,
    summary: blocked.length ? `${label} can't use the terminal.` : `${label} can use every tool.`,
    blocked_tools: blocked,
    other_blocked_tools: [],
    groups: [
      group("terminal", "Terminal & Processes", ["process", "terminal"], ["process", "terminal"].filter((t) => b.has(t)), true),
      group("browser", "Browser Automation", ["browser_click", "browser_navigate"], ["browser_click", "browser_navigate"].filter((t) => b.has(t))),
      group("skills", "Skills", ["skill_manage", "skill_view"], ["skill_manage", "skill_view"].filter((t) => b.has(t))),
    ],
    ...extra,
  };
}

const ROLES = [
  role("owner", "The owner", []),
  role("admin", "Admins", []),
  role("member", "Members", ["process", "terminal", "skill_manage"]),
];

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = await handler(String(input), init);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
}

describe("RoleLimitsSection", () => {
  it("shows each role in plain words and is read-only without canEdit", async () => {
    mockFetch(() => ({ roles: ROLES }));
    render(<RoleLimitsSection canEdit={false} />);
    expect(await screen.findByText("Members can't use the terminal.")).toBeTruthy();
    expect(screen.getByText(/Only the owner or an admin can change this/)).toBeTruthy();
    expect(screen.getByText("always everything")).toBeTruthy();
    const terminal = screen.getByLabelText("Members: Terminal & Processes") as HTMLInputElement;
    expect(terminal.checked).toBe(false);
    expect(terminal.disabled).toBe(true);
    expect(screen.getAllByText("risky").length).toBeGreaterThan(0);
    expect(screen.getByText("Blocked: skill manage")).toBeTruthy();
    expect(screen.queryByText("Reset to defaults")).toBeNull();
  });

  it("blocks a group inline, shows a busy state and ignores a second tap", async () => {
    let release: (() => void) | undefined;
    const updated = ROLES.map((r) =>
      r.role === "member"
        ? role("member", "Members", ["browser_click", "browser_navigate", "process", "terminal", "skill_manage"], { customised: true })
        : r,
    );
    const spy = mockFetch(async (_url, init) => {
      if (init?.method === "PUT") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, roles: updated };
      }
      return { roles: ROLES };
    });
    render(<RoleLimitsSection canEdit />);
    // Browser isn't risky or blocked, so it sits behind "Show all".
    fireEvent.click(await screen.findAllByText(/Show all 3 tool groups/).then((b) => b[b.length - 1]));
    const browser = screen.getByLabelText("Members: Browser Automation") as HTMLInputElement;
    expect(browser.checked).toBe(true);
    fireEvent.click(browser);
    fireEvent.click(browser);
    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect((screen.getByLabelText("Members: Browser Automation") as HTMLInputElement).disabled).toBe(true);

    const puts = spy.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(String(puts[0][0])).toBe("/api/access/roles/member");
    expect(JSON.parse(String(puts[0][1]?.body))).toEqual({
      deny_tools: ["browser_click", "browser_navigate", "process", "skill_manage", "terminal"],
    });

    release?.();
    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect((screen.getByLabelText("Members: Browser Automation") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("customised")).toBeTruthy();
    expect(screen.getByText("Reset to defaults")).toBeTruthy();
  });

  it("asks before letting members use a risky group", async () => {
    const spy = mockFetch((_url, init) =>
      init?.method === "PUT" ? { ok: true, roles: ROLES } : { roles: ROLES },
    );
    render(<RoleLimitsSection canEdit />);
    fireEvent.click(await screen.findByLabelText("Members: Terminal & Processes"));
    expect(screen.getByText(/Let members use Terminal & Processes\?/)).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() =>
      expect(spy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
    );
    const put = spy.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ deny_tools: ["skill_manage"] });
  });

  it("resets a customised role and shows a save error", async () => {
    const custom = ROLES.map((r) => (r.role === "member" ? { ...r, customised: true } : r));
    const spy = mockFetch((_url, init) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ detail: "Only the owner or an admin can change what each role can use." }), { status: 403 })
        : { roles: custom },
    );
    render(<RoleLimitsSection canEdit />);
    fireEvent.click(await screen.findByText("Reset to defaults"));
    expect(await screen.findByText(/Couldn't save: Only the owner or an admin/)).toBeTruthy();
    const put = spy.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ reset: true });
  });

  it("explains a load failure", async () => {
    mockFetch(() => new Response(JSON.stringify({ detail: "boom" }), { status: 502 }));
    render(<RoleLimitsSection canEdit />);
    expect(await screen.findByText(/Couldn't load what each role can use \(boom\)/)).toBeTruthy();
  });
});
