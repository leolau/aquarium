/**
 * The 8 palette tokens a generated app icon sits on, hashed from the name
 * when the app has not picked one (the Projects icon/colour convention).
 */
export const APP_ICON_COLORS = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "red",
  "pink",
  "violet",
] as const;
export type AppIconColor = (typeof APP_ICON_COLORS)[number];

const HEX: Record<AppIconColor, string> = {
  blue: "#3b6fd8",
  teal: "#0f8f8a",
  green: "#2f8f4e",
  amber: "#b7791f",
  orange: "#c2561a",
  red: "#c53b3b",
  pink: "#be3c86",
  violet: "#6d4fc4",
};

export function isAppIconColor(value: unknown): value is AppIconColor {
  return typeof value === "string" && (APP_ICON_COLORS as readonly string[]).includes(value);
}

/** Stable FNV-1a hash, so a name always lands on the same colour. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function appIconColor(name: string, chosen?: string | null): AppIconColor {
  if (isAppIconColor(chosen)) return chosen;
  return APP_ICON_COLORS[hash(name) % APP_ICON_COLORS.length];
}

export function appIconHex(color: AppIconColor): string {
  return HEX[color];
}
