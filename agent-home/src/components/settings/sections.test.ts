import { describe, expect, it } from "vitest";

import {
  canOpenSettingsSection,
  isDetailSection,
  settingsSectionHref,
  settingsEntryHref,
  settingsIndexGroups,
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
    expect(canOpenSettingsSection("aquarium", member)).toBe(false);
    expect(canOpenSettingsSection("aquarium", { canManageMembers: true, canManageTools: false })).toBe(true);
    expect(visibleSettingsSections({ canManageMembers: true, canManageTools: true })).toContain("menu");
  });
});

describe("settings index groups", () => {
  it("splits You from This Aquarium and links the admin pages", () => {
    const admin = settingsIndexGroups({ canManageMembers: true, canManageTools: true });
    expect(admin.you).toContain("language");
    expect(admin.you).not.toContain("upgrade");
    expect(admin.admin).toEqual(expect.arrayContaining(["people", "capacity", "upgrade", "menu"]));
    expect(settingsEntryHref("people")).toBe("/users");
    expect(settingsEntryHref("activity")).toBe("/activity");
    expect(settingsEntryHref("get-ready")).toBe("/settings/get-ready");
  });

  it("gives non-admins a locked group with only what they may read", () => {
    const member = settingsIndexGroups({ canManageMembers: false, canManageTools: false });
    expect(member.admin).toEqual([]);
    expect(member.readOnly).toEqual(["entity-goal", "tools"]);
  });
});
