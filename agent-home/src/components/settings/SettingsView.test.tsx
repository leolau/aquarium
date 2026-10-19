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
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain('data-component="SettingsView"');
  });

  it("renders the colour theme section", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Colour theme");
  });

  it("renders the Connected accounts section", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [], credentials: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Connected accounts");
  });

  it("groups Google, VPN, WhatsApp and Telegram under In&Out", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [], credentials: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView />);
    const inOut = html.indexOf('data-section="in-out"');
    expect(inOut).toBeGreaterThan(-1);
    expect(html).toContain("In&amp;Out");
    const sectionEnd = html.indexOf('data-section="entity-goal"');
    const inside = html.slice(inOut, sectionEnd);
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
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Tags");
    expect(html).toContain('data-section="tags"');
  });

  it("renders the create form with name input, color dropdown, and Create button", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    const html = renderToStaticMarkup(<SettingsView />);
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
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Loading your tags");
    expect(html).toContain('aria-busy="true"');
  });

  it("labels the Tools & Integrations link by what the person may do", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tags: [] })),
    );
    expect(renderToStaticMarkup(<SettingsView />)).toContain("Manage integrations");
    const html = renderToStaticMarkup(<SettingsView canManageTools={false} />);
    expect(html).toContain("View integrations");
    expect(html).not.toContain("Manage integrations");
  });
});

describe("SettingsView language", () => {
  it("offers the EN / 繁體中文 switch inline, with English active by default", () => {
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).toContain("Region and language");
    expect(html).toContain('data-component="LanguageSwitch"');
    expect(html).toContain("繁體中文");
    expect(html).toMatch(/aria-pressed="true"[^>]*>EN</);
  });
});
