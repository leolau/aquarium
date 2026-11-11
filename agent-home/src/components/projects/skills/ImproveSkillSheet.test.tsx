// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImproveSkillSheet } from "@/components/projects/skills/ImproveSkillSheet";

const LIVE = "---\nname: pdf-tidy\n---\n\nRun qpdf.\n";
const VERSIONS = {
  name: "pdf-tidy",
  active: "v2",
  versions: [{ id: "v2", n: 2, created_at: 1, author: "u", message: "m", parent: null, status: "active", source: "edit", trial_of: null }],
};
const ev = (id: number, slug: string | null, title: string, outcome: string | null) => ({
  id, ts: 1790000000 + id, trigger: "preload", version_id: "v2", outcome, outcome_source: "kanban", rating: null, note: null,
  session: null, task: { id: `t${id}`, title }, project: slug ? { slug, name: slug } : null, user_id: "u",
});
const EVENTS = {
  name: "pdf-tidy",
  events: [ev(1, "site-relaunch", "Hero banner PDF", "failure"), ev(2, "secret-deal", "Acme merger memo", "success")],
  next_cursor: null,
};

const fetchMock = vi.fn();
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
const callsTo = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).split("?")[0] === path);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const path = url.split("?")[0];
    if (path === "/api/skills/versions") return json(VERSIONS);
    if (path === "/api/skills/content") return json({ name: "pdf-tidy", content: LIVE });
    if (path === "/api/skills/usage/detail") return json(EVENTS);
    if (path === "/api/skills/improve/start") return json({ session_id: "imp-1" });
    if (path === "/api/skills/improve/message") return json({ reply: "Here:\n```skill-draft\n---\nname: pdf-tidy\n---\n\nRun qpdf --check.\n```" });
    if (path === "/api/skills/versions/draft") return json({ ...VERSIONS.versions[0], id: "v3", n: 3, status: "draft" });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const onClose = vi.fn();
const sheet = (profile = "coder") =>
  render(<ImproveSkillSheet project={{ slug: "site-relaunch", name: "Site relaunch" }} skill={{ name: "pdf-tidy", profile }} onClose={onClose} />);

describe("ImproveSkillSheet", () => {
  it("shows only this project's runs as evidence, scoped to the skill's profile", async () => {
    sheet();
    expect(await screen.findByText("Hero banner PDF")).toBeTruthy();
    expect(screen.queryByText("Acme merger memo")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Improve pdf-tidy with AI" })).toBeTruthy();
    expect(screen.getByText("Evidence: project Site relaunch")).toBeTruthy();
    const detail = String(callsTo("/api/skills/usage/detail")[0][0]);
    expect(detail).toContain("project=site-relaunch");
    expect(detail).toContain("profile=coder");
    expect(screen.getByRole("link", { name: "Open in Skills Lab" }).getAttribute("href")).toBe(
      "/skills/pdf-tidy?profile=coder&tab=improve&project=site-relaunch",
    );
  });

  it("starts a project-scoped improve chat, proposes a draft and saves it credited to the chat", async () => {
    sheet();
    fireEvent.click(await screen.findByText("Hero banner PDF"));
    const box = screen.getByLabelText("Message to the agent") as HTMLTextAreaElement;
    expect(box.value).toContain("run #1");
    fireEvent.change(box, { target: { value: "Why did this fail?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByRole("region", { name: "Proposed SKILL.md" });
    expect(bodyOf(callsTo("/api/skills/improve/start")[0])).toEqual({ name: "pdf-tidy", project: "site-relaunch", profile: "coder" });
    expect(bodyOf(callsTo("/api/skills/improve/message")[0])).toEqual({ session_id: "imp-1", text: "Why did this fail?", profile: "coder" });

    fireEvent.click(screen.getByRole("button", { name: /Save as draft v3/ }));
    await screen.findByText(/Saved as draft v3/);
    expect(bodyOf(callsTo("/api/skills/versions/draft")[0])).toMatchObject({
      name: "pdf-tidy",
      session_id: "imp-1",
      profile: "coder",
      message: "Improve with AI from project Site relaunch",
    });
    expect(screen.getByRole("link", { name: "Open in Versions" }).getAttribute("href")).toBe("/skills/pdf-tidy?profile=coder&tab=versions");
  });

  it("closes from the sheet's close control", async () => {
    sheet("default");
    await waitFor(() => expect(callsTo("/api/skills/usage/detail")).toHaveLength(1));
    expect(String(callsTo("/api/skills/usage/detail")[0][0])).not.toContain("profile=");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
