// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { SkillEditor } from "@/components/skills/SkillEditor";
import { SkillPage } from "@/components/skills/SkillPage";
import type { SkillDetails, SkillInfo } from "@/types";

const DOC = `---
name: pdf-tools
description: Fill PDFs. Use when a task involves a PDF.
version: 2.3.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
x-unknown: keep me
metadata:
  hermes:
    tags: [PDF, Documents]
    related_skills: [powerpoint, not-installed]
    category: productivity
---

# PDF tools

Use \`web_extract\` first. <script>alert(1)</script><img src=x onerror="alert(2)">

## Step 1

\`\`\`python
print("hi")
\`\`\`

> [!TIP]
> Check disk space.

| Need | Use |
| --- | --- |
| Text | pymupdf |
`;

const SKILL: SkillInfo = { name: "pdf-tools", description: "Fill PDFs.", category: "productivity", enabled: true, source: "builtin" };
const DETAILS: SkillDetails = {
  name: "pdf-tools",
  files: [
    { path: "SKILL.md", size: 6100 },
    { path: "scripts/split.py", size: 2048 },
  ],
  files_truncated: false,
  modified_at: 1790000000,
  used_by: [
    { profile: "default", enabled: true },
    { profile: "worker", enabled: false },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function page(details: SkillDetails | null = DETAILS, skill: SkillInfo = SKILL) {
  return <SkillPage name="pdf-tools" profile="default" content={DOC} skill={skill} details={details} installed={["pdf-tools", "powerpoint"]} />;
}

describe("SkillPage", () => {
  it("server-renders the document, outline and details deterministically", () => {
    const html = renderToString(page());
    expect(html).toContain('data-component="SkillPage"');
    expect(html).toContain("v2.3.0");
    expect(html).toContain("built-in");
    expect(html).toMatch(/<h1 id="sec-pdf-tools"/);
    expect(html).toContain('href="#sec-step-1"');
    expect(html).toContain("python</span>");
    expect(html).toMatch(/data-callout="tip"[^>]*>\s*<p[^>]*><b class="mr-1">Tip:<\/b>/);
    expect(html).toContain("<table");
    expect(html).toContain("Hermes Agent · MIT");
    expect(html).toContain('href="/skills/powerpoint"');
    expect(html).not.toContain('href="/skills/not-installed"');
    // HTML in a skill is sanitized.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    // The date is locale/time-zone independent on the server (ISO day).
    expect(html).toContain(">2026-09-21</time>");
    expect(renderToString(page())).toBe(html);
  });

  it("hydrates without mismatches and then shows a localized date", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(page());
    document.body.appendChild(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { hydrateRoot } = await import("react-dom/client");
    await act(async () => {
      hydrateRoot(container, page(), { onRecoverableError: (e) => console.error(e) });
    });
    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector("time")?.textContent).not.toBe("2026-09-21");
    errors.mockRestore();
    container.remove();
  });

  it("shows Files and Used by from the details endpoint, with no absolute paths", () => {
    render(page());
    fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
    expect(screen.getByText("scripts/split.py")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/\/home\/|\.hermes/);
    fireEvent.click(screen.getByRole("tab", { name: /Used by/ }));
    expect(screen.getByText("worker")).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
  });

  it("orders the tabs and opens the Usage tab from ?tab=usage", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: "down" }), { status: 502 })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<SkillPage name="pdf-tools" profile="default" content={DOC} skill={SKILL} details={DETAILS} installed={["pdf-tools"]} initialTab="usage" />);
      const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.match(/^(Instructions|Files|Usage|Versions|Improve|Used by)/)?.[0]);
      const order = ["Instructions", "Files", "Usage", "Versions", "Improve", "Used by"];
      expect(tabs).toContain("Usage");
      expect(tabs.map((t) => order.indexOf(t ?? ""))).toEqual([...tabs.map((t) => order.indexOf(t ?? ""))].sort((a, b) => a - b));
      expect(screen.getByRole("tab", { name: /Usage/ }).getAttribute("aria-selected")).toBe("true");
      await screen.findByText("Usage couldn't be loaded");
      fireEvent.click(screen.getByRole("tab", { name: /Files/ }));
      expect(window.location.search).toBe("?tab=files");
      fireEvent.click(screen.getByRole("tab", { name: /Instructions/ }));
      expect(window.location.search).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("degrades when details are unavailable", () => {
    render(page(null));
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText(/couldn.t be loaded/)).toBeTruthy();
  });

  it("offers uninstall only for hub skills", () => {
    render(page());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Uninstall…" })).toBeNull();
    cleanup();
    render(page(DETAILS, { ...SKILL, source: "hub" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Uninstall…" })).toBeTruthy();
  });
});

function editor(view: "structured" | "plain" = "structured") {
  return (
    <SkillEditor name="pdf-tools" profile="default" content={DOC} skill={SKILL} installed={["pdf-tools", "powerpoint"]} categories={["productivity", "research"]} initialView={view} />
  );
}

const plainText = () => screen.getByLabelText("SKILL.md") as HTMLTextAreaElement;
const instructions = () => screen.getByLabelText("Instructions (Markdown)") as HTMLTextAreaElement;

describe("SkillEditor", () => {
  it("server-renders both views of the same document", () => {
    const structured = renderToString(editor());
    expect(structured).toContain('data-view="structured"');
    expect(structured).toContain('value="2.3.0"');
    expect(structured).toContain("Built-in skill");
    const plain = renderToString(editor("plain"));
    expect(plain).toContain("x-unknown: keep me");
  });

  it("keeps edits when switching between Structured and Plain text", () => {
    render(editor());
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2.4.0" } });
    fireEvent.change(instructions(), { target: { value: instructions().value + "\nNew line from structured.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    const doc = plainText().value;
    expect(doc).toContain("version: 2.4.0\n");
    expect(doc).toContain("New line from structured.");
    expect(doc).toContain("x-unknown: keep me\n");
    fireEvent.change(plainText(), { target: { value: doc.replace("license: MIT", "license: Apache-2.0").replace("New line", "Edited line") } });
    fireEvent.click(screen.getByRole("button", { name: "Structured" }));
    expect((screen.getByLabelText("Version") as HTMLInputElement).value).toBe("2.4.0");
    expect(instructions().value).toContain("Edited line from structured.");
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(plainText().value).toContain("license: Apache-2.0");
  });

  it("edits tags as chips and preserves unknown keys", () => {
    render(editor());
    const add = screen.getByLabelText("Add tag");
    fireEvent.change(add, { target: { value: "OCR" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Documents" }));
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(plainText().value).toContain("    tags: [PDF, OCR]\n");
    expect(plainText().value).toBe(DOC.replace("[PDF, Documents]", "[PDF, OCR]"));
  });

  it("shows unsaved changes, a diff to review, and blocks saving invalid files", () => {
    render(editor("plain"));
    expect(document.querySelector('[data-component="SkillSaveBar"]')).toBeNull();
    fireEvent.change(plainText(), { target: { value: DOC.replace("name: pdf-tools", "name: renamed") } });
    expect(screen.getByText(/Unsaved changes · 1 line/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    expect(document.querySelector('[data-op="del"]')?.textContent).toBe("- name: pdf-tools");
    expect(document.querySelector('[data-op="add"]')?.textContent).toBe("+ name: renamed");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the whole document through the BFF", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(editor());
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2.3.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/skills/content", expect.objectContaining({ method: "PUT" }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ name: "pdf-tools", content: DOC.replace("version: 2.3.0", "version: 2.3.1") });
    expect(router.push).toHaveBeenCalledWith("/skills/pdf-tools");
    vi.unstubAllGlobals();
  });

  it("asks (in the themed dialog) before an in-app link drops unsaved changes", async () => {
    render(editor());
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "9.9.9" } });
    const link = screen.getByRole("link", { name: /pdf-tools/ });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(await screen.findByText("Leave without saving?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Leave without saving?")).toBeNull());
  });
});
