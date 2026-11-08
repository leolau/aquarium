// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { SkillEditor } from "@/components/skills/SkillEditor";
import { SkillPage } from "@/components/skills/SkillPage";
import { SkillVersionsPanel } from "@/components/skills/SkillVersionsPanel";

const NOW = Date.now() / 1000;
const meta = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  n,
  created_at: NOW - (6 - n) * 3600,
  author: "user:leo",
  message: `message ${n}`,
  parent: n > 1 ? `v${n - 1}` : null,
  status,
  source: n === 1 ? "baseline" : "edit",
  sha256: "x",
  trial_of: null,
  ...extra,
});

const LIST = {
  name: "quote-builder",
  active: "v2",
  versions: [meta("v1", 1, "archived"), meta("v2", 2, "active"), meta("v3", 3, "draft", { author: "agent:s1", source: "improve" })],
};
const DIFF = "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -40,2 +40,2 @@ Steps\n ## Steps\n-1. Read the brief.\n+1. Read the brief and confirm currency.\n";

type Handler = (url: string, init?: RequestInit) => unknown;
let fetchMock: ReturnType<typeof vi.fn>;

function serve(routes: Record<string, Handler | unknown>) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.split("?")[0];
    const r = routes[`${init?.method ?? "GET"} ${path}`];
    if (r === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const body = typeof r === "function" ? (r as Handler)(input, init) : r;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const calls = (method: string, path: string) =>
  fetchMock.mock.calls.filter(([u, i]) => (i?.method ?? "GET") === method && String(u).split("?")[0] === path);
const bodyOf = (method: string, path: string) => JSON.parse(String(calls(method, path).at(-1)?.[1]?.body));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillVersionsPanel", () => {
  it("shows a loading state, then an error with retry", async () => {
    let fail = true;
    serve({
      "GET /api/skills/versions": () => (fail ? new Response(JSON.stringify({ error: "Backend down" }), { status: 502 }) : { ...LIST, versions: [] }),
    });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    expect(screen.getByText("Loading versions…")).toBeTruthy();
    expect(await screen.findByText("Version history couldn't be loaded.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No versions yet/)).toBeTruthy();
  });

  it("lists versions newest first and diffs active → newest draft by default", async () => {
    serve({ "GET /api/skills/versions": LIST, "GET /api/skills/versions/diff": { a: "v2", b: "v3", diff: DIFF } });
    render(<SkillVersionsPanel name="quote-builder" profile="coder" />);
    await screen.findByText("Compare v2 (active) → v3 (draft)");
    expect([...document.querySelectorAll("[data-version]")].map((e) => e.getAttribute("data-version"))).toEqual(["v3", "v2", "v1"]);
    expect(document.querySelector('[data-version="v3"]')?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Baseline")).toBeTruthy();
    expect(await screen.findByText("+1 −1 lines in SKILL.md")).toBeTruthy();
    const del = document.querySelector('[data-op="del"]');
    const add = document.querySelector('[data-op="add"]');
    expect(del?.textContent).toBe("41−1. Read the brief.");
    expect(add?.textContent).toBe("41+1. Read the brief and confirm currency.");
    const url = String(calls("GET", "/api/skills/versions/diff")[0][0]);
    expect(url).toContain("a=v2");
    expect(url).toContain("b=v3");
    expect(url).toContain("profile=coder");
    expect(screen.getByRole("region", { name: "About v3" }).textContent).toContain("agent · Improve chat");
    const edit = screen.getByRole("link", { name: /Edit draft/ });
    expect(edit.getAttribute("href")).toBe("/skills/quote-builder/edit?profile=coder&draft=v3");
  });

  it("compares any two versions picked in the selects", async () => {
    serve({ "GET /api/skills/versions": LIST, "GET /api/skills/versions/diff": (u: string) => ({ a: "", b: "", diff: u.includes("a=v1") ? DIFF : "" }) });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    await screen.findByText("Compare v2 (active) → v3 (draft)");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "v1" } });
    expect(await screen.findByText("Compare v1 → v3 (draft)")).toBeTruthy();
    await waitFor(() => expect(String(calls("GET", "/api/skills/versions/diff").at(-1)?.[0])).toContain("a=v1&b=v3"));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "v2" } });
    expect(await screen.findByText("Compare v1 → v2 (active)")).toBeTruthy();
    expect(screen.getByRole("region", { name: "About v2" })).toBeTruthy();
  });

  it("Try activates the draft as a trial and refreshes the page", async () => {
    serve({
      "GET /api/skills/versions": LIST,
      "GET /api/skills/versions/diff": { diff: DIFF },
      "POST /api/skills/versions/activate": { active: "v3", versions: [meta("v1", 1, "archived"), meta("v2", 2, "archived"), meta("v3", 3, "active", { trial_of: "v2" })] },
    });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    await screen.findByText("Compare v2 (active) → v3 (draft)");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Try v3" })[0]);
    });
    expect(bodyOf("POST", "/api/skills/versions/activate")).toEqual({ name: "quote-builder", id: "v3", trial: true });
    expect(router.refresh).toHaveBeenCalled();
    expect(await screen.findByText("Trying v3")).toBeTruthy();
    expect(screen.getByText("Active · trial")).toBeTruthy();
  });

  it("Restore confirms first, then activates the older version", async () => {
    serve({
      "GET /api/skills/versions": LIST,
      "GET /api/skills/versions/diff": { diff: DIFF },
      "POST /api/skills/versions/activate": { active: "v1", versions: [meta("v1", 1, "active"), meta("v2", 2, "archived"), meta("v3", 3, "draft")] },
    });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    await screen.findByText("Compare v2 (active) → v3 (draft)");
    fireEvent.click(screen.getByRole("button", { name: "Restore v1" }));
    expect(
      screen.getByText("v1 becomes the active version for new chats. Other versions stay in history, so you can switch back at any time."),
    ).toBeTruthy();
    expect(calls("POST", "/api/skills/versions/activate")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Restore v1" }).at(-1) as HTMLElement);
    });
    expect(bodyOf("POST", "/api/skills/versions/activate")).toEqual({ name: "quote-builder", id: "v1", trial: false });
    expect(await screen.findByText("v1 is now the active version.")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("trial banner compares usage and offers Keep and Revert", async () => {
    const trial = { name: "quote-builder", active: "v3", versions: [meta("v2", 2, "archived"), meta("v3", 3, "active", { trial_of: "v2" })] };
    serve({
      "GET /api/skills/versions": trial,
      "GET /api/skills/versions/diff": { diff: DIFF },
      "GET /api/skills/usage/detail": {
        by_version: [
          { version_id: "v3", uses: 9, success_rate: 0.78 },
          { version_id: "v2", uses: 31, success_rate: 0.61 },
        ],
      },
      "POST /api/skills/versions/activate": (_u: string, init?: RequestInit) => {
        const id = JSON.parse(String(init?.body)).id;
        return { active: id, versions: [meta("v2", 2, id === "v2" ? "active" : "archived"), meta("v3", 3, id === "v3" ? "active" : "archived")] };
      },
    });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    expect(await screen.findByText("Trying v3")).toBeTruthy();
    expect(await screen.findByText(/9 uses, 78% success \(v2: 61%\)/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revert to v2" }));
    });
    expect(bodyOf("POST", "/api/skills/versions/activate")).toEqual({ name: "quote-builder", id: "v2", trial: false });
    expect(await screen.findByText("Reverted to v2.")).toBeTruthy();
    expect(screen.queryByText("Trying v3")).toBeNull();
  });

  it("Keep ends the trial on the same version", async () => {
    const trial = { name: "q", active: "v3", versions: [meta("v2", 2, "archived"), meta("v3", 3, "active", { trial_of: "v2" })] };
    serve({
      "GET /api/skills/versions": trial,
      "GET /api/skills/versions/diff": { diff: DIFF },
      "POST /api/skills/versions/activate": { active: "v3", versions: [meta("v2", 2, "archived"), meta("v3", 3, "active")] },
    });
    render(<SkillVersionsPanel name="q" profile="default" />);
    await screen.findByText("Trying v3");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Keep v3" }));
    });
    expect(bodyOf("POST", "/api/skills/versions/activate")).toEqual({ name: "q", id: "v3", trial: false });
    expect(await screen.findByText("v3 is now the active version.")).toBeTruthy();
  });

  it("shows a failed activation without losing the history", async () => {
    serve({
      "GET /api/skills/versions": LIST,
      "GET /api/skills/versions/diff": { diff: DIFF },
      "POST /api/skills/versions/activate": () => new Response(JSON.stringify({ error: "Version is gone" }), { status: 409 }),
    });
    render(<SkillVersionsPanel name="quote-builder" profile="default" />);
    await screen.findByText("Compare v2 (active) → v3 (draft)");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Try v3" })[0]);
    });
    expect(await screen.findByText(/Version is gone/)).toBeTruthy();
    expect(document.querySelectorAll("[data-version]")).toHaveLength(3);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("Versions on the skill page", () => {
  const DOC = "---\nname: q\ndescription: Quotes.\nversion: 1.0.0\n---\n\n# Q\n";

  it("opens on ?tab=versions and shows the active version in the header chip", async () => {
    serve({ "GET /api/skills/versions": LIST, "GET /api/skills/versions/diff": { diff: DIFF } });
    render(<SkillPage name="q" profile="default" content={DOC} skill={null} details={null} installed={["q"]} initialTab="versions" activeVersion={{ n: 2, trial: false }} />);
    expect(screen.getByText("v2 · active")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Versions" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Compare v2 (active) → v3 (draft)")).toBeTruthy();
  });

  it("orders the tabs and falls back to Instructions for unknown deep links", () => {
    serve({});
    render(<SkillPage name="q" profile="default" content={DOC} skill={null} details={null} installed={["q"]} initialTab="nope" />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.indexOf("Versions")).toBeGreaterThan(tabs.indexOf("Files"));
    expect(tabs.indexOf("Versions")).toBeLessThan(tabs.findIndex((t) => t?.startsWith("Used by")));
    expect(screen.getByRole("tab", { name: "Instructions" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("v1.0.0")).toBeTruthy();
  });
});

describe("SkillEditor in draft mode", () => {
  it("saves a new draft instead of the live skill and returns to Versions", async () => {
    const DRAFT = "---\nname: q\ndescription: Quotes.\nversion: 1.0.0\n---\n\n# Q draft\n";
    serve({ "POST /api/skills/versions/draft": meta("v4", 4, "draft") });
    render(<SkillEditor name="q" profile="coder" content={DRAFT} skill={null} installed={["q"]} categories={[]} initialView="plain" draft={{ id: "v3", n: 3 }} />);
    fireEvent.change(screen.getByLabelText("SKILL.md"), { target: { value: `${DRAFT}\nMore.\n` } });
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    expect(screen.getByText("Save as a new draft of q?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls("PUT", "/api/skills/content")).toHaveLength(0);
    expect(bodyOf("POST", "/api/skills/versions/draft")).toEqual({ name: "q", content: `${DRAFT}\nMore.\n`, message: "Edited from v3", profile: "coder" });
    expect(router.push).toHaveBeenCalledWith("/skills/q?profile=coder&tab=versions");
  });
});
