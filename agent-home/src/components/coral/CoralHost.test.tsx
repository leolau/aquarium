// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

// CoralHost uses usePathname — mock to a neutral path so no tile is active.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
// NavGlyph's useLinkStatus only works inside the App Router's link context;
// in unit tests the tile just shows its glyph.
vi.mock("next/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/link")>();
  return {
    ...actual,
    useLinkStatus: () => ({ pending: false }),
  };
});

import { CoralHost } from "@/components/coral/CoralHost";

const ALL_DESTINATIONS = [
  "Home",
  "To-dos",
  "Chat",
  "Inbox",
  "Memory",
  "Projects",
  "Files",
  "Activity",
  "Graph",
  "Capacity",
  "Users",
  "Suggestions",
  "Tools",
  "Core area",
  "Agent webview",
  "Settings",
  "Getting started",
];

const openCoral = () =>
  fireEvent.click(screen.getByRole("button", { name: /open coral menu/i }));

describe("CoralHost (SSR)", () => {
  it("renders the FAB closed — no panel in server markup", () => {
    const html = renderToStaticMarkup(<CoralHost />);
    expect(html).toContain('data-component="CoralHost"');
    expect(html).toContain("Open Coral menu");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('aria-expanded="true"');
  });
});

describe("CoralHost grid panel", () => {
  it("opens on tap and shows every destination at once — no nesting", () => {
    render(<CoralHost />);
    openCoral();
    const menu = screen.getByRole("menu", { name: /coral launcher/i });
    for (const label of ALL_DESTINATIONS) {
      expect(menu.textContent).toContain(label);
    }
    // Cluster categories render as section headers.
    expect(menu.textContent).toContain("Workspace");
    expect(menu.textContent).toContain("System");
    expect(screen.getByRole("button", { name: /close coral menu/i })).toBeTruthy();
  });

  it("leaves out apps hidden from the caller's role", () => {
    render(<CoralHost hiddenApps={["graph", "todos"]} />);
    openCoral();
    const menu = screen.getByRole("menu", { name: /coral launcher/i });
    expect(menu.querySelector('a[href="/graph"]')).toBeNull();
    expect(menu.querySelector('a[href="/todos"]')).toBeNull();
    expect(menu.querySelector('a[href="/settings"]')).toBeTruthy();
  });

  it("tints the Main, Workspace and System sections distinctly", () => {
    render(<CoralHost />);
    openCoral();
    const menu = screen.getByRole("menu", { name: /coral launcher/i });
    expect(menu.querySelector(".coral-section--main")).toBeTruthy();
    expect(menu.querySelector(".coral-section--workspace")).toBeTruthy();
    expect(menu.querySelector(".coral-section--system")).toBeTruthy();
  });

  it("renders one menuitem per destination (18 tiles)", () => {
    render(<CoralHost />);
    openCoral();
    expect(screen.getAllByRole("menuitem")).toHaveLength(18);
  });

  it("marks the active route with aria-current", () => {
    render(<CoralHost />);
    openCoral();
    const home = screen.getByRole("menuitem", { name: /home/i });
    expect(home.getAttribute("aria-current")).toBe("page");
  });

  it("closes on backdrop click and returns focus to the FAB", () => {
    render(<CoralHost />);
    const fab = screen.getByRole("button", { name: /open coral menu/i });
    fireEvent.click(fab);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.click(document.querySelector(".coral-backdrop") as Element);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(fab);
  });

  it("closes on Escape", () => {
    render(<CoralHost />);
    openCoral();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders the todos badge count on the To-dos tile", () => {
    render(<CoralHost badgeCounts={{ "todos-open": 4 }} />);
    openCoral();
    expect(screen.getByRole("menu", { name: /coral launcher/i }).textContent).toContain("4");
  });

  it("tiles are real links with their routes", () => {
    render(<CoralHost />);
    openCoral();
    const settings = screen.getByRole("menuitem", { name: /settings/i });
    expect(settings.getAttribute("href")).toBe("/settings");
  });
});
