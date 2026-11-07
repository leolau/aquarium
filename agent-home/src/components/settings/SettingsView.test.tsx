import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsView } from "@/components/settings/SettingsView";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/**
 * SSR-based tests for SettingsView.
 *
 * renderToStaticMarkup does not run useEffect, so the tag fetch never fires
 * during SSR — the component renders its initial state (loading=true).  We
 * test the parts that are always visible (theme selector, Tags section header,
 * create form) and the loading message.
 */
describe("SettingsView", () => {
  it("renders the settings container", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="theme" />);
    expect(html).toContain('data-component="SettingsView"');
    expect(html).toContain('href="/settings"');
  });

  it("renders the colour theme section", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="theme" />);
    expect(html).toContain("Colour theme");
  });

  it("renders the Connected accounts section", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [], credentials: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="in-out" />);
    expect(html).toContain("Connected accounts");
  });

  it("groups Google, VPN, WhatsApp and Telegram under In&Out", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [], credentials: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="in-out" />);
    const inOut = html.indexOf('data-section="in-out"');
    expect(inOut).toBeGreaterThan(-1);
    expect(html).toContain("In&amp;Out");
    const inside = html.slice(inOut);
    expect(inside).toContain('data-component="ConnectedAccounts"');
    expect(inside).toContain('data-component="VpnConnections"');
    expect(inside.indexOf('data-component="VpnConnections"')).toBeGreaterThan(
      inside.indexOf('data-component="ConnectedAccounts"'),
    );
    expect(inside).toContain('data-component="WhatsAppBridges"');
    expect(inside).toContain('data-component="TelegramLinks"');
    expect(inside).not.toContain('href="/users"');
  });

  it("renders the Tags section header", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="tags" />);
    expect(html).toContain("Tags");
    expect(html).toContain('data-section="tags"');
  });

  it("renders the create form with name input, color dropdown, and Create button", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="tags" />);
    // Name input
    expect(html).toContain("Tag name");
    // Create button
    expect(html).toContain("Create");
    // Color dropdown options
    expect(html).toContain("Blue");
    expect(html).toContain("Red");
    expect(html).toContain("Green");
    expect(html).toContain("Amber");
    expect(html).toContain("Purple");
    expect(html).toContain("Gray");
  });

  it("renders loading state for tag list during SSR (useEffect does not run)", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView section="tags" />);
    expect(html).toContain("Loading your tags");
    expect(html).toContain('aria-busy="true"');
  });

  it("renders the index as one link per section, not the sections themselves", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    for (const [id, href] of [
      ["language", "/settings/language"],
      ["theme", "/settings/theme"],
      ["in-out", "/settings/in-out"],
      ["menu", "/settings/menu"],
      ["tools", "/settings/tools"],
      ["get-ready", "/settings/get-ready"],
      ["upgrade", "/settings/upgrade"],
      ["tags", "/settings/tags"],
    ]) {
      expect(html).toContain(`data-section-link="${id}"`);
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain('data-section="in-out"');
    expect(html).not.toContain('data-section="tags"');
    expect(html).not.toContain('data-component="MenuSection"');
  });

  it("hides the tiles a member may not open", () => {
    const html = renderToStaticMarkup(
      <SettingsView canManageMembers={false} canManageTools={false} />,
    );
    for (const id of ["menu", "apps", "uploads", "upgrade"]) {
      expect(html).not.toContain(`data-section-link="${id}"`);
    }
    expect(html).toContain('data-section-link="tools"');
    expect(html).toContain('data-section-link="tags"');
  });
});

describe("SettingsView language", () => {
  it("offers the EN / 繁體中文 switch inline, with English active by default", () => {
    const html = renderToStaticMarkup(<SettingsView section="language" />);
    expect(html).toContain("Region and language");
    expect(html).toContain('data-component="LanguageSwitch"');
    expect(html).toContain("繁體中文");
    expect(html).toMatch(/aria-pressed="true"[^>]*>EN</);
  });
});
