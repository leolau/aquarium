// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MenuSection } from "@/components/settings/MenuSection";

const NAV = {
  role: "admin",
  is_owner: false,
  hidden: [],
  locked: ["home", "settings"],
  apps: [],
  roles: { admin: [], member: ["graph"], viewer: [] },
};

const fetchMock = vi.fn();

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("MenuSection", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows one tab per role and launcher groups", async () => {
    fetchMock.mockReturnValue(reply(NAV));
    render(<MenuSection />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Admin", "Member", "Viewer"]);
    await screen.findByRole("tabpanel");
    for (const g of ["main", "workspace", "system"]) {
      expect(document.querySelector(`[data-group="${g}"]`)).toBeTruthy();
    }
  });

  it("reflects each role's own hidden list", async () => {
    fetchMock.mockReturnValue(reply(NAV));
    render(<MenuSection />);
    const graph = (await screen.findByLabelText(/show graph to member/i)) as HTMLInputElement;
    expect(graph.checked).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Viewer" }));
    expect((screen.getByLabelText(/show graph to viewer/i) as HTMLInputElement).checked).toBe(true);
  });

  it("locks Profiles and Skills off for members and viewers only", async () => {
    fetchMock.mockReturnValue(reply(NAV));
    render(<MenuSection />);
    await screen.findByRole("tabpanel");
    fireEvent.click(screen.getByRole("tab", { name: "Admin" }));
    for (const name of [/show profiles to admin/i, /show skills to admin/i]) {
      const box = (await screen.findByLabelText(name)) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(false);
    }
    for (const role of ["Member", "Viewer"]) {
      fireEvent.click(screen.getByRole("tab", { name: role }));
      for (const app of ["profiles", "skills"]) {
        const box = screen.getByLabelText(new RegExp(`show ${app} to ${role}`, "i")) as HTMLInputElement;
        expect(box.checked).toBe(false);
        expect(box.disabled).toBe(true);
      }
    }
    expect(document.querySelectorAll('[data-locked-off="true"]').length).toBeGreaterThan(0);
  });

  it("locks Home and Settings on", async () => {
    fetchMock.mockReturnValue(reply(NAV));
    render(<MenuSection />);
    for (const name of [/show home to/i, /show settings to/i]) {
      const box = (await screen.findByLabelText(name)) as HTMLInputElement;
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(true);
    }
  });

  it("keeps a toggle as a draft until Save, then saves the role's list", async () => {
    fetchMock.mockReturnValueOnce(reply(NAV));
    render(<MenuSection />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const todos = screen.getByLabelText(/show to-dos to member/i) as HTMLInputElement;
    expect(todos.checked).toBe(true);
    fireEvent.click(todos);
    expect(todos.checked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Unsaved changes for Member");
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockReturnValueOnce(reply({ ...NAV, roles: { ...NAV.roles, member: ["graph", "todos"] } }));
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/settings/menu/member");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ hidden: ["graph", "todos"] });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved"));
    expect((screen.getByLabelText(/show to-dos to member/i) as HTMLInputElement).checked).toBe(false);
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("Discard drops the draft without saving", async () => {
    fetchMock.mockReturnValueOnce(reply(NAV));
    render(<MenuSection />);
    const todos = (await screen.findByLabelText(/show to-dos to member/i)) as HTMLInputElement;
    fireEvent.click(todos);
    expect(todos.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(todos.checked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps each role's draft when switching tabs", async () => {
    fetchMock.mockReturnValueOnce(reply(NAV));
    render(<MenuSection />);
    fireEvent.click(await screen.findByLabelText(/show to-dos to member/i));
    fireEvent.click(screen.getByRole("tab", { name: "Viewer" }));
    expect((screen.getByLabelText(/show to-dos to viewer/i) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("tab", { name: /Member/ }).textContent).toContain("•");
    fireEvent.click(screen.getByRole("tab", { name: /Member/ }));
    expect((screen.getByLabelText(/show to-dos to member/i) as HTMLInputElement).checked).toBe(false);
  });

  it("labels Profiles and Skills 'Admins only' and says the owner sees everything", async () => {
    fetchMock.mockReturnValueOnce(reply({ ...NAV, role: "owner", is_owner: true }));
    render(<MenuSection />);
    await screen.findByRole("tabpanel");
    const labels = [...document.querySelectorAll('[data-locked-off="true"]')].map((n) => n.textContent);
    expect(labels).toEqual(["Admins only", "Admins only"]);
    expect(document.body.textContent).toContain("You are the owner, so your own menu always shows everything");
  });

  it("is read-only without per-role lists", async () => {
    fetchMock.mockReturnValue(reply({ ...NAV, roles: undefined, role: "member" }));
    render(<MenuSection />);
    expect(((await screen.findByLabelText(/show graph to member/i)) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the server's error on a failed save", async () => {
    fetchMock.mockReturnValueOnce(reply(NAV));
    render(<MenuSection />);
    fireEvent.click(await screen.findByLabelText(/show to-dos to member/i));
    fetchMock.mockReturnValueOnce(reply({ detail: "Unknown menu item" }, 400));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unknown menu item");
  });
});
