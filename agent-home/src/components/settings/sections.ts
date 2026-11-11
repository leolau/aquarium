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
  "aquarium",
  "model-timeouts",
  "skills-permissions",
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
    case "aquarium":
    case "model-timeouts":
    case "skills-permissions":
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

/** An entry on the Settings index: a section, or a page with its own route. */
export type SettingsEntryId = SettingsSectionId | "activity" | "people" | "capacity";

const ENTRY_HREF: Partial<Record<SettingsEntryId, string>> = {
  activity: "/activity",
  people: "/users",
  capacity: "/capacity",
};

export function settingsEntryHref(id: SettingsEntryId): string {
  return ENTRY_HREF[id] ?? settingsSectionHref(id as SettingsSectionId);
}

/** "You": personal settings and this device. Everyone may open them. */
export const YOU_ENTRIES: SettingsEntryId[] = [
  "language",
  "account",
  "theme",
  "notifications",
  "in-out",
  "tags",
  "get-ready",
  "activity",
];

/** "This Aquarium": settings that change the install for everyone. */
export const ADMIN_ENTRIES: SettingsEntryId[] = [
  "people",
  "tools",
  "entity-goal",
  "capacity",
  "uploads",
  "apps",
  "menu",
  "skills-permissions",
  "aquarium",
  "model-timeouts",
  "upgrade",
];

/** Admin entries a non-admin may still open, read-only. */
export const READ_ONLY_ADMIN_ENTRIES: SettingsEntryId[] = ["entity-goal", "tools"];

export interface SettingsIndexGroups {
  you: SettingsEntryId[];
  /** Admin entries the caller manages; empty when they manage none. */
  admin: SettingsEntryId[];
  /** Non-admins: the admin entries they may read (shown in the locked card). */
  readOnly: SettingsEntryId[];
}

export function settingsIndexGroups(access: SettingsAccess): SettingsIndexGroups {
  if (access.canManageMembers) {
    return {
      you: YOU_ENTRIES,
      admin: ADMIN_ENTRIES.filter(
        (id) => !isSettingsSection(id) || canOpenSettingsSection(id, access),
      ),
      readOnly: [],
    };
  }
  const readOnly = [...READ_ONLY_ADMIN_ENTRIES];
  if (access.canManageTools) readOnly.push("menu");
  return { you: YOU_ENTRIES, admin: [], readOnly };
}
