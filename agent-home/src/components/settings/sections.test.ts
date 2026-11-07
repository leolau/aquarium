import { describe, expect, it } from "vitest";

import {
  canOpenSettingsSection,
  isDetailSection,
  settingsSectionHref,
  visibleSettingsSections,
} from "@/components/settings/sections";

describe("settings sections", () => {
  it("gives every section its own page", () => {
    expect(settingsSectionHref("menu")).toBe("/settings/menu");
    expect(settingsSectionHref("tools")).toBe("/settings/tools");
    expect(isDetailSection("menu")).toBe(true);
    expect(isDetailSection("tools")).toBe(false);
    expect(isDetailSection("nope")).toBe(false);
  });

  it("keeps owner/admin sections from members", () => {
    const member = { canManageMembers: false, canManageTools: false };
    expect(canOpenSettingsSection("menu", member)).toBe(false);
    expect(canOpenSettingsSection("apps", member)).toBe(false);
    expect(canOpenSettingsSection("tags", member)).toBe(true);
    expect(visibleSettingsSections({ canManageMembers: true, canManageTools: true })).toContain("menu");
  });
});
