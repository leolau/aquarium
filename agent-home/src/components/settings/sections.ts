/**
 * Settings sections: the tiles on `/settings` and the detail page each opens.
 * Server-safe (no "use client"), so the `[section]` route can 404 on an unknown
 * id or one the caller may not open.
 */
export const SETTINGS_SECTIONS = [
  "language",
  "account",
  "theme",
  "notifications",
  "in-out",
  "uploads",
  "apps",
  "menu",
  "tools",
  "get-ready",
  "upgrade",
  "entity-goal",
  "tags",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsAccess {
  canManageMembers: boolean;
  canManageTools: boolean;
}

/** Sections that already have their own route under `/settings`. */
const OWN_ROUTE: Partial<Record<SettingsSectionId, string>> = {
  tools: "/settings/tools",
  "get-ready": "/settings/get-ready",
  upgrade: "/settings/upgrade",
};

export function isSettingsSection(id: string): id is SettingsSectionId {
  return (SETTINGS_SECTIONS as readonly string[]).includes(id);
}

export function settingsSectionHref(id: SettingsSectionId): string {
  return OWN_ROUTE[id] ?? `/settings/${id}`;
}

/** Whether `id` renders on the `/settings/[section]` route (not its own route). */
export function isDetailSection(id: string): id is SettingsSectionId {
  return isSettingsSection(id) && !OWN_ROUTE[id];
}

export function canOpenSettingsSection(id: SettingsSectionId, access: SettingsAccess): boolean {
  switch (id) {
    case "uploads":
    case "apps":
    case "upgrade":
      return access.canManageMembers;
    case "menu":
      return access.canManageTools;
    default:
      return true;
  }
}

export function visibleSettingsSections(access: SettingsAccess): SettingsSectionId[] {
  return SETTINGS_SECTIONS.filter((id) => canOpenSettingsSection(id, access));
}
